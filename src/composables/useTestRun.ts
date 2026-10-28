import { computed, reactive, ref, type UnwrapNestedRefs } from 'vue';
import { api, type ManualChecks, type ManualCheckState, type StoredTestRun, type TestRunEvent } from '../api';
import { errorMessage } from './utils';

type Env = 'dev' | 'homolog' | 'producao';

export interface TestResultRow {
  itemId: string;
  title: string;
  status: 'ok' | 'failed' | 'not-applicable';
  detail?: string;
}

interface RunStore {
  running: boolean;
  runningGroup: string | undefined;
  currentTest: { itemId: string; title: string } | undefined;
  /** Etapa fora dos testes (subindo Docker, front etc.), mostrada enquanto nenhum teste roda. */
  status: string;
  progressTotal: number;
  testResults: TestResultRow[];
  manualChecks: ManualChecks;
  runError: string;
  startedAt: number | undefined;
  finishedAt: number | undefined;
}

/** Por "promoção:ambiente": a rodada segue viva (e visível) ao trocar de aba/promoção e voltar. */
const stores = new Map<string, RunStore>();
/** Cada PUT manda o mapa inteiro: em fila, o servidor recebe na ordem em que foram marcados. */
const checksSaves = new WeakMap<RunStore, Promise<unknown>>();
const controllers = new Map<string, AbortController>();
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

function getStore(promotionId: string, env: Env): RunStore {
  const key = `${promotionId}:${env}`;
  let store = stores.get(key);
  if (!store) {
    store = reactive<RunStore>({
      running: false,
      runningGroup: undefined,
      currentTest: undefined,
      status: '',
      progressTotal: 0,
      testResults: [],
      manualChecks: {},
      runError: '',
      startedAt: undefined,
      finishedAt: undefined,
    });
    stores.set(key, store);
    const created = store;
    api.getLastTestRun(promotionId, env).then(
      (run) => run && restoreRun(created, run),
      (e) => { if (!created.startedAt) created.runError = errorMessage(e); },
    );
  }
  return store;
}

/** Rodada iniciada nesta aba antes da resposta chegar tem prioridade sobre a salva. */
function restoreRun(store: RunStore, run: StoredTestRun): void {
  if (store.startedAt) return;
  Object.assign(store, {
    progressTotal: run.total,
    testResults: run.results,
    manualChecks: run.manualChecks,
    runError: run.error ?? (run.finishedAt === null ? 'Rodada não concluída: ainda em andamento em outra aba ou interrompida antes do fim.' : ''),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? run.startedAt,
  });
}

function syncClock(): void {
  const anyRunning = [...stores.values()].some((store) => store.running);
  if (anyRunning && !clock) {
    now.value = Date.now();
    clock = setInterval(() => { now.value = Date.now(); }, 1000);
  } else if (!anyRunning && clock) {
    clearInterval(clock);
    clock = undefined;
  }
}

function applyEvent(store: RunStore, event: TestRunEvent): void {
  if (event.type === 'begin') store.progressTotal = event.total;
  else if (event.type === 'status') Object.assign(store, { status: event.message, currentTest: undefined });
  else if (event.type === 'test-begin') Object.assign(store, { status: '', currentTest: { itemId: event.id, title: event.title } });
  else if (event.type === 'test-end') {
    store.testResults.push({ itemId: event.id, title: event.title, status: event.status, detail: event.detail });
  }
}

export function useTestRun(promotionId: () => string, env: () => Env) {
  const key = () => `${promotionId()}:${env()}`;
  const store = computed(() => getStore(promotionId(), env()));

  const running = computed(() => store.value.running);
  const runningGroup = computed(() => store.value.runningGroup);
  const currentTest = computed(() => store.value.currentTest);
  const status = computed(() => store.value.status);
  const progressTotal = computed(() => store.value.progressTotal);
  const testResults = computed(() => store.value.testResults);
  const runError = computed(() => store.value.runError);
  const manualChecks = computed(() => store.value.manualChecks);
  const progressDone = computed(() => testResults.value.length);
  const progressPercent = computed(() => (progressTotal.value ? Math.round((progressDone.value / progressTotal.value) * 100) : 0));
  const okCount = computed(() => testResults.value.filter((row) => row.status === 'ok').length);
  const failedCount = computed(() => testResults.value.filter((row) => row.status === 'failed').length);
  const naCount = computed(() => testResults.value.filter((row) => row.status === 'not-applicable').length);
  const elapsedMs = computed(() => {
    const { startedAt, finishedAt } = store.value;
    return startedAt ? (finishedAt ?? now.value) - startedAt : 0;
  });

  async function runTests(headed = false, group?: string, quantity?: number): Promise<void> {
    const id = promotionId();
    const environment = env();
    const runKey = `${id}:${environment}`;
    const target = getStore(id, environment);
    if (target.running) return;
    Object.assign(target, {
      running: true,
      runningGroup: group ?? 'all',
      currentTest: undefined,
      status: '',
      progressTotal: 0,
      testResults: [],
      manualChecks: {},
      runError: '',
      startedAt: Date.now(),
      finishedAt: undefined,
    });
    const controller = new AbortController();
    controllers.set(runKey, controller);
    syncClock();
    try {
      await api.runTests(id, environment, headed, group, quantity, (event) => applyEvent(target, event), controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) target.runError = errorMessage(e);
    } finally {
      target.finishedAt = Date.now();
      target.running = false;
      target.runningGroup = undefined;
      target.currentTest = undefined;
      target.status = '';
      controllers.delete(runKey);
      syncClock();
    }
  }

  /** `undefined` tira o item da conferência. */
  async function setManualChecks(updates: Record<string, ManualCheckState | undefined>): Promise<void> {
    const target = store.value;
    const [id, runEnv] = [promotionId(), env()];
    const apply = (changes: Record<string, ManualCheckState | undefined>) => {
      const next = { ...target.manualChecks };
      for (const [itemId, state] of Object.entries(changes)) {
        if (state) next[itemId] = state;
        else delete next[itemId];
      }
      target.manualChecks = next;
    };
    const save = () => {
      const queued = (checksSaves.get(target) ?? Promise.resolve()).then(() => api.saveTestRunChecks(id, runEnv, target.manualChecks));
      checksSaves.set(target, queued.catch(() => {}));
      return queued;
    };
    const previous = Object.fromEntries(Object.keys(updates).map((itemId) => [itemId, target.manualChecks[itemId]]));
    apply(updates);
    try {
      await save();
    } catch (e) {
      target.runError = errorMessage(e);
      // Desfaz só os itens desta chamada, sem apagar o que outra marcou depois, e regrava pra o servidor ficar igual à tela.
      apply(Object.fromEntries(Object.entries(previous).filter(([itemId]) => target.manualChecks[itemId] === updates[itemId])));
      await save().catch((error: unknown) => (target.runError = errorMessage(error)));
    }
  }

  function stopTests(): void {
    controllers.get(key())?.abort();
  }

  return { running, runningGroup, currentTest, status, progressTotal, progressDone, progressPercent, testResults, manualChecks, runError, okCount, failedCount, naCount, elapsedMs, runTests, stopTests, setManualChecks };
}

export type TestRunState = UnwrapNestedRefs<ReturnType<typeof useTestRun>>;
