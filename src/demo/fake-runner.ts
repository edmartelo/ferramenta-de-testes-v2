import { MASS_REGISTRATION_GROUPS, TEST_GROUPS } from '../../knowledge-base/test-groups';
import type { TestRunEvent } from '../../server/test-runner';
import type { StoredTestRun } from '../../server/test-runs';

export const DEMO_TEST_TITLES: Record<string, string[]> = {
  'participant-registration': [
    'Cadastro com dados válidos conclui com sucesso',
    'CPF inválido exibe erro no campo',
    'E-mail em formato inválido é recusado',
    'Celular com DDD inválido é recusado',
    'Senha fraca exibe a regra de senha',
    'Campos obrigatórios vazios bloqueiam o envio',
    'Aceite do regulamento é obrigatório',
    'CEP preenche o endereço automaticamente',
  ],
  'coupon-registration': [
    'Cupom válido é cadastrado e aparece em Meus Cupons',
    'CNPJ inválido é recusado',
    'Data da compra fora do período é recusada',
    'Cupom duplicado é recusado',
    'Valor abaixo do mínimo exibe aviso',
    'Limite diário de cupons é respeitado',
  ],
  'my-data': [
    'Meus Dados exibe os dados do cadastro',
    'Alteração de telefone é salva',
    'Alteração de endereço é salva',
    'Troca de senha exige a senha atual',
    'Sair encerra a sessão',
  ],
};

export const DEMO_FAILURES = [
  'Modal de sucesso não apareceu após o envio (timeout de 15 s).',
  'Mensagem esperada "CPF inválido" não foi exibida; o formulário foi enviado.',
  'A API respondeu 500 ao cadastrar o cupom.',
  'O botão "Salvar" continuou desabilitado com os campos preenchidos.',
];

export const DEMO_NOT_APPLICABLE = [
  'Campo não encontrado no formulário — revisão manual.',
  'Regra não informada na mecânica — revisão manual.',
];

function abortError(): DOMException {
  return new DOMException('Operação cancelada.', 'AbortError');
}

export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

type FakeStatus = 'ok' | 'failed' | 'not-applicable';

/** Sorteio novo a cada rodada; com 3 testes ou mais sai ao menos um ok, uma falha e um N/A. */
export function plannedStatuses(total: number, random: () => number = Math.random): FakeStatus[] {
  if (total < 3) return Array.from({ length: total }, () => (random() < 0.6 ? 'ok' : random() < 0.5 ? 'failed' : 'not-applicable'));
  const failedCount = 1 + Math.floor(random() * Math.max(1, Math.round(total * 0.3)));
  const naCount = Math.min(1 + Math.floor(random() * Math.max(1, Math.round(total * 0.2))), total - failedCount - 1);
  const order = Array.from({ length: total }, (_, index) => ({ index, key: random() })).sort((a, b) => a.key - b.key).map(({ index }) => index);
  const statuses: FakeStatus[] = Array(total).fill('ok');
  for (const index of order.slice(0, failedCount)) statuses[index] = 'failed';
  for (const index of order.slice(failedCount, failedCount + naCount)) statuses[index] = 'not-applicable';
  return statuses;
}

function plannedTests(group: string | undefined, quantity: number | undefined): { id: string; title: string }[] {
  const mass = MASS_REGISTRATION_GROUPS.find((g) => g.id === group);
  if (mass) {
    return Array.from({ length: Math.max(1, Math.min(quantity ?? 5, 20)) }, (_, index) => ({ id: `${mass.id}/${index}`, title: `${mass.label} fictício ${index + 1}` }));
  }
  const groups = group ? TEST_GROUPS.filter((g) => g.id === group) : TEST_GROUPS;
  return groups.flatMap((g) => (DEMO_TEST_TITLES[g.id] ?? []).map((title, index) => ({ id: `${g.id}/${index}`, title })));
}

interface FakeRunOptions {
  group: string | undefined;
  quantity: number | undefined;
  onEvent: (event: TestRunEvent) => void;
  signal?: AbortSignal;
  /** Recebe a rodada assim que começa e a vê crescer, como a tabela `test_runs` na ferramenta. */
  onStart?: (run: StoredTestRun) => void;
}

/** Emite os mesmos eventos do `test-runner.ts`, com ok, falhas e N/A sorteados a cada rodada. */
export async function runFakeTests({ group, quantity, onEvent, signal, onStart }: FakeRunOptions): Promise<StoredTestRun> {
  const tests = plannedTests(group, quantity);
  const statuses = plannedStatuses(tests.length);
  const run: StoredTestRun = { runGroup: group ?? 'all', total: tests.length, results: [], manualChecks: {}, error: null, startedAt: Date.now(), finishedAt: null };
  onStart?.(run);
  onEvent({ type: 'begin', total: tests.length });
  onEvent({ type: 'status', message: 'Abrindo o navegador simulado...' });
  await wait(700, signal);
  for (const [index, test] of tests.entries()) {
    onEvent({ type: 'test-begin', id: test.id, title: test.title });
    await wait(300 + Math.random() * 1200, signal);
    const status = statuses[index]!;
    const detail = status === 'failed' ? DEMO_FAILURES[Math.floor(Math.random() * DEMO_FAILURES.length)] : status === 'not-applicable' ? DEMO_NOT_APPLICABLE[Math.floor(Math.random() * DEMO_NOT_APPLICABLE.length)] : undefined;
    run.results.push({ itemId: test.id, title: test.title, status, detail });
    onEvent({ type: 'test-end', id: test.id, title: test.title, status, detail });
  }
  run.finishedAt = Date.now();
  onEvent({ type: 'end', success: true });
  return run;
}
