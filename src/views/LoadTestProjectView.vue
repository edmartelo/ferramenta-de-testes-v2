<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api, type LoadEnv, type LoadPreview, type LoadRun, type LoadTestStatus } from '../api';
import { errorMessage } from '../composables/utils';
import { useModalDialog } from '../composables/useModalDialog';
import {
  formatDateTime,
  formatMs,
  formatPct,
  formatRps,
  LOAD_ENV_HINTS,
  LOAD_ENV_LABELS,
  LOAD_STATUS_LABELS,
  reportUrl,
} from '../lib/load-test-labels';

const props = defineProps<{ id: string }>();

const POLL_MS = 4_000;

const status = ref<LoadTestStatus>();
const promotionName = ref('');
const loadError = ref('');
const formError = ref('');
const env = ref<LoadEnv>('staging');
const scenario = ref('');
const users = ref(5);
const durationSec = ref(60);
const preview = ref<LoadPreview>();
const previewing = ref(false);
const starting = ref(false);
const startError = ref('');
const canceling = ref(false);
const selectedRunId = ref<string>();
const dialog = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

useModalDialog(dialog, () => Boolean(preview.value));

const running = computed(() => status.value?.running ?? null);
const smokeDone = computed(() => status.value?.smokeDone.includes(`${env.value}:${scenario.value}`) ?? false);
const maxUsers = computed(() => (smokeDone.value ? status.value?.limits.maxUsers : status.value?.limits.smokeUsers) ?? 5);
const selectedRun = computed<LoadRun | undefined>(() => {
  const history = status.value?.history ?? [];
  return history.find((run) => run.id === selectedRunId.value) ?? history[0];
});
const canStart = computed(() => Boolean(status.value && !running.value && !status.value.busyElsewhere && status.value.envs.includes(env.value) && scenario.value));

async function load(): Promise<void> {
  clearTimeout(timer);
  try {
    status.value = await api.getLoadTests(props.id);
    loadError.value = '';
    if (!scenario.value) scenario.value = status.value.scenarios[0]?.id ?? '';
    if (!status.value.envs.includes(env.value) && status.value.envs[0]) env.value = status.value.envs[0];
  } catch (e) {
    loadError.value = errorMessage(e);
  }
  if (status.value?.running || status.value?.busyElsewhere) timer = setTimeout(load, POLL_MS);
}

async function loadName(): Promise<void> {
  try {
    promotionName.value = (await api.listPromotions()).find((promotion) => promotion.id === props.id)?.name ?? props.id;
  } catch {
    promotionName.value = props.id;
  }
}

async function openPreview(): Promise<void> {
  formError.value = '';
  startError.value = '';
  previewing.value = true;
  try {
    preview.value = await api.previewLoadTest(props.id, { env: env.value, scenario: scenario.value, users: users.value, durationSec: durationSec.value });
  } catch (e) {
    formError.value = errorMessage(e);
  } finally {
    previewing.value = false;
  }
}

async function confirmStart(): Promise<void> {
  if (!preview.value) return;
  starting.value = true;
  startError.value = '';
  try {
    const { siteUrl, apiUrl, users: confirmedUsers, durationSec: confirmedDuration } = preview.value;
    const { runId } = await api.startLoadTest(props.id, {
      env: preview.value.env,
      scenario: preview.value.scenario,
      users: confirmedUsers,
      durationSec: confirmedDuration,
      confirm: { siteUrl, apiUrl, users: confirmedUsers, durationSec: confirmedDuration },
    });
    preview.value = undefined;
    selectedRunId.value = runId;
    await load();
  } catch (e) {
    startError.value = errorMessage(e);
  } finally {
    starting.value = false;
  }
}

async function cancel(): Promise<void> {
  canceling.value = true;
  try {
    await api.cancelLoadTest(props.id);
  } catch (e) {
    formError.value = errorMessage(e);
  } finally {
    canceling.value = false;
  }
  await load();
}

function scenarioLabel(id: string): string {
  return status.value?.scenarios.find((item) => item.id === id)?.label ?? id;
}

function codesText(codes: Record<string, number>): string {
  return Object.entries(codes).sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => `${code}: ${count}`).join(' · ') || '–';
}

watch(() => props.id, () => {
  selectedRunId.value = undefined;
  status.value = undefined;
  void load();
  void loadName();
}, { immediate: true });
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div class="load-view">
    <header class="page-header">
      <router-link to="/carga" class="back-link">← JMeter</router-link>
      <h1>{{ promotionName || 'Carregando...' }}</h1>
      <p>Teste de carga pelo JMeter no Docker desta máquina. Produção nunca recebe carga: o servidor recusa o host de Produção de qualquer promoção.</p>
    </header>

    <p v-if="loadError" role="alert" class="error-text">{{ loadError }}</p>
    <p v-else-if="!status" role="status" class="progress-caption">Carregando...</p>

    <template v-if="status">
      <section class="card load-form" aria-labelledby="load-form-title">
        <h2 id="load-form-title">Nova rodada</h2>
        <p v-if="!status.envs.length" role="alert" class="load-banner">Cadastre a URL do site em Dev ou Homolog para rodar o teste de carga.</p>
        <div class="load-fields">
          <label>
            Ambiente
            <select v-model="env" :disabled="Boolean(running)">
              <option v-for="key in (['staging', 'dev'] as const)" :key="key" :value="key" :disabled="!status.envs.includes(key)">
                {{ LOAD_ENV_LABELS[key] }}{{ status.envs.includes(key) ? '' : ' (sem URL)' }}
              </option>
            </select>
          </label>
          <label>
            Cenário
            <select v-model="scenario" :disabled="Boolean(running)">
              <option v-for="item in status.scenarios" :key="item.id" :value="item.id">{{ item.label }}</option>
            </select>
          </label>
          <label>
            Usuários simultâneos
            <input v-model.number="users" type="number" min="1" :max="maxUsers" :disabled="Boolean(running)" />
          </label>
          <label>
            Duração (segundos)
            <input v-model.number="durationSec" type="number" :min="status.limits.minDurationSec" :max="status.limits.maxDurationSec" step="10" :disabled="Boolean(running)" />
          </label>
        </div>
        <p class="field-hint">{{ LOAD_ENV_HINTS[env] }}</p>
        <p class="field-hint">
          {{ status.scenarios.find((item) => item.id === scenario)?.description }}
          <template v-if="!smokeDone"> Primeiro uma rodada leve: até {{ status.limits.smokeUsers }} usuários até ela terminar sem erros neste ambiente.</template>
          <template v-else> Rodada leve já aprovada: até {{ status.limits.maxUsers }} usuários.</template>
        </p>
        <p v-if="status.busyElsewhere" role="status" class="load-banner">O JMeter desta máquina está rodando a carga de outra promoção.</p>
        <p v-if="formError" role="alert" class="error-text">{{ formError }}</p>
        <div class="load-actions">
          <button v-if="!running" type="button" class="primary" :disabled="!canStart || previewing" @click="openPreview">
            {{ previewing ? 'Conferindo o alvo...' : 'Revisar e rodar' }}
          </button>
          <button v-else type="button" class="danger" :disabled="canceling" @click="cancel">{{ canceling ? 'Cancelando...' : 'Cancelar rodada' }}</button>
        </div>
      </section>

      <section v-if="running" class="card load-progress" role="status" aria-live="polite">
        <h2>Rodando em {{ LOAD_ENV_LABELS[running.env] }} · {{ running.users }} usuários · {{ running.durationSec }} s</h2>
        <p class="field-hint">{{ running.siteUrl }}</p>
        <dl v-if="running.progress" class="load-metrics">
          <div><dt>Tempo</dt><dd>{{ running.progress.elapsedSec }} s</dd></div>
          <div><dt>Requisições</dt><dd>{{ running.progress.samples }}</dd></div>
          <div><dt>Vazão</dt><dd>{{ formatRps(running.progress.rps) }}</dd></div>
          <div><dt>Média</dt><dd>{{ formatMs(running.progress.avgMs) }}</dd></div>
          <div><dt>Erros</dt><dd>{{ running.progress.errors }} ({{ formatPct(running.progress.errorPct) }})</dd></div>
        </dl>
        <p v-else class="progress-caption">Subindo o JMeter...</p>
      </section>

      <section class="card load-history" aria-labelledby="load-history-title">
        <h2 id="load-history-title">Rodadas</h2>
        <p v-if="!status.history.length" class="progress-caption">Nenhuma rodada ainda.</p>
        <div v-else class="load-history-layout">
          <ul class="load-runs">
            <li v-for="run in status.history" :key="run.id">
              <button type="button" class="load-run" :class="{ active: selectedRun?.id === run.id }" :aria-pressed="selectedRun?.id === run.id" @click="selectedRunId = run.id">
                <span :class="`load-status load-status-${run.status}`">{{ LOAD_STATUS_LABELS[run.status] }}</span>
                <span>{{ formatDateTime(run.startedAt) }} · {{ LOAD_ENV_LABELS[run.env] }}</span>
                <span>{{ run.users }} usuários · {{ run.durationSec }} s</span>
              </button>
            </li>
          </ul>

          <article v-if="selectedRun" class="load-run-detail">
            <h3>{{ scenarioLabel(selectedRun.scenario) }} · {{ LOAD_ENV_LABELS[selectedRun.env] }}</h3>
            <p class="field-hint">
              {{ selectedRun.siteUrl }}<template v-if="selectedRun.apiUrl"> · API {{ selectedRun.apiUrl }}</template>
              · ramp-up {{ selectedRun.rampUpSec }} s · medido de {{ selectedRun.machine }}
            </p>
            <p v-if="selectedRun.error" role="alert" class="error-text">{{ selectedRun.error }}</p>
            <template v-if="selectedRun.summary?.total">
              <dl class="load-metrics">
                <div><dt>Requisições</dt><dd>{{ selectedRun.summary.total.samples }}</dd></div>
                <div><dt>Erro</dt><dd>{{ formatPct(selectedRun.summary.total.errorPct) }}</dd></div>
                <div><dt>Vazão</dt><dd>{{ formatRps(selectedRun.summary.total.rps) }}</dd></div>
                <div><dt>p50</dt><dd>{{ formatMs(selectedRun.summary.total.p50Ms) }}</dd></div>
                <div><dt>p95</dt><dd>{{ formatMs(selectedRun.summary.total.p95Ms) }}</dd></div>
                <div><dt>p99</dt><dd>{{ formatMs(selectedRun.summary.total.p99Ms) }}</dd></div>
              </dl>
              <div class="load-table-wrap">
                <table class="load-table">
                  <thead>
                    <tr>
                      <th scope="col">Etapa</th>
                      <th scope="col">Req.</th>
                      <th scope="col">Erro</th>
                      <th scope="col">p50</th>
                      <th scope="col">p95</th>
                      <th scope="col">p99</th>
                      <th scope="col">Máx.</th>
                      <th scope="col">Vazão</th>
                      <th scope="col">Códigos</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in selectedRun.summary.transactions" :key="item.label">
                      <th scope="row">{{ item.label }}</th>
                      <td>{{ item.samples }}</td>
                      <td :class="{ 'load-bad': item.errorPct > 1 }">{{ formatPct(item.errorPct) }}</td>
                      <td>{{ formatMs(item.p50Ms) }}</td>
                      <td>{{ formatMs(item.p95Ms) }}</td>
                      <td>{{ formatMs(item.p99Ms) }}</td>
                      <td>{{ formatMs(item.maxMs) }}</td>
                      <td>{{ formatRps(item.rps) }}</td>
                      <td>{{ codesText(item.codes) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
            <p v-if="selectedRun.status !== 'running'">
              <a v-if="selectedRun.reportAvailable" :href="reportUrl(selectedRun.id)" target="_blank" rel="noopener">Abrir relatório completo do JMeter <span aria-hidden="true">↗</span></a>
              <span v-else class="field-hint">Relatório HTML só na máquina {{ selectedRun.machine }} (ou já apagado após 30 dias).</span>
            </p>
          </article>
        </div>
      </section>
    </template>

    <div v-if="preview" class="modal-backdrop" @keydown.esc.stop="!starting && (preview = undefined)">
      <div ref="dialog" class="card modal-card" role="alertdialog" aria-modal="true" aria-labelledby="load-confirm-title">
        <h3 id="load-confirm-title">Confirmar teste de carga</h3>
        <dl class="load-confirm">
          <div><dt>Ambiente</dt><dd>{{ LOAD_ENV_LABELS[preview.env] }}</dd></div>
          <div><dt>Site</dt><dd>{{ preview.siteUrl }}</dd></div>
          <div><dt>API</dt><dd>{{ preview.apiUrl ?? 'fora da carga' }}</dd></div>
          <div><dt>Cenário</dt><dd>{{ scenarioLabel(preview.scenario) }}</dd></div>
          <div><dt>Carga</dt><dd>{{ preview.users }} usuários por {{ preview.durationSec }} s (ramp-up {{ preview.rampUpSec }} s)</dd></div>
        </dl>
        <p v-if="preview.apiNote" class="field-hint">{{ preview.apiNote }}</p>
        <p v-if="preview.env === 'staging'" class="field-hint">Homolog é compartilhado com as agências: confira se o horário foi combinado.</p>
        <p v-if="startError" role="alert" class="error-text">{{ startError }}</p>
        <div class="card-footer">
          <button type="button" class="ghost" :disabled="starting" @click="preview = undefined">Voltar</button>
          <button type="button" class="primary" :disabled="starting" @click="confirmStart">{{ starting ? 'Iniciando...' : 'Rodar agora' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.load-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1200px;
}

.load-view .page-header {
  margin-bottom: 0;
}

.load-view h2 {
  font-size: 16px;
  margin: 0 0 12px;
}

.load-banner {
  color: var(--warning);
  background: var(--warning-soft);
  border: 1px solid var(--warning);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  margin: 0 0 12px;
}

.load-fields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px 16px;
}

.load-fields label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
}

.load-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.load-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 12px;
  margin: 12px 0;
}

.load-metrics div,
.load-confirm div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.load-metrics dt,
.load-confirm dt {
  color: var(--text-secondary);
  font-size: 12px;
}

.load-metrics dd {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.load-confirm {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 12px 0;
}

.load-confirm dd {
  margin: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.load-history-layout {
  display: grid;
  grid-template-columns: minmax(200px, 260px) minmax(0, 1fr);
  gap: 16px;
}

.load-runs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.load-run {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  text-align: left;
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  color: var(--text-secondary);
  font-size: 12px;
}

.load-run.active {
  border-color: var(--accent);
  background: var(--surface-hover);
}

.load-run-detail {
  min-width: 0;
}

.load-run-detail h3 {
  margin: 0 0 4px;
  font-size: 15px;
}

.load-status {
  font-weight: 700;
  font-size: 13px;
}

.load-status-ok {
  color: var(--accent-green);
}

.load-status-errors,
.load-status-failed,
.load-status-interrupted {
  color: var(--danger);
}

.load-status-running {
  color: var(--accent);
}

.load-table-wrap {
  overflow-x: auto;
}

.load-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.load-table th,
.load-table td {
  text-align: right;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.load-table th:first-child,
.load-table td:last-child {
  text-align: left;
}

.load-bad {
  color: var(--danger);
  font-weight: 700;
}

@media (max-width: 720px) {
  .load-history-layout {
    grid-template-columns: 1fr;
  }
}
</style>
