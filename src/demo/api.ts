import type { PromotionConfig, PromotionStage } from '../../promotions/types';
import { MASS_REGISTRATION_GROUPS, MASS_REGISTRATION_LIMITS, TEST_GROUPS } from '../../knowledge-base/test-groups';
import type { api as realApi, ManualChecks, StoredLog, StoredTestRun } from '../api';
import { runFakeTests, wait } from './fake-runner';
import { demoMonday } from './monday-fixtures';
import {
  DEMO_AGENCIES,
  demoAtendimentos,
  demoInitialRun,
  demoLogs,
  randomDemoLogs,
  demoLogUsers,
  demoPromotions,
  demoRecurrences,
  demoSummary,
} from './fixtures';

export type * from '../api';

/** Build da demo: troca `src/api.ts` por este arquivo. Só login/cadastro vão ao servidor; o resto é fictício e fica na memória da aba. */

type Api = typeof realApi;
type Env = 'dev' | 'homolog' | 'producao';

const FULL_VERSION_ONLY = 'Disponível na versão completa da ferramenta.';
const HIDDEN_CREDENTIAL = '••••••••';
const ENV_KEY = { dev: 'dev', homolog: 'staging', producao: 'production' } as const;

const promotions = demoPromotions();
const testRuns = new Map<string, StoredTestRun>([['verao-premiado:homolog', demoInitialRun()]]);
let schedule = { enabled: false, slots: ['09:00', '14:00', '18:00'] };
let accessBump = 0;

const fullVersionOnly = (): Promise<never> => Promise.reject(new Error(FULL_VERSION_ONLY));

function findPromotion(id: string): PromotionConfig {
  const promotion = promotions.find((p) => p.id === id);
  if (!promotion) throw new Error('Promoção não encontrada.');
  return promotion;
}

function hiddenCredentials() {
  return { adminPanelUser: HIDDEN_CREDENTIAL, adminPanelPassword: HIDDEN_CREDENTIAL, testParticipantCpf: HIDDEN_CREDENTIAL, testParticipantPassword: HIDDEN_CREDENTIAL };
}

async function request<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', data?: unknown): Promise<T> {
  const res = await fetch(`/api/demo${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    credentials: 'same-origin',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Erro ${res.status}.`);
  return body as T;
}

interface Turnstile {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

interface PublicConfig {
  captchaSiteKey: string | null;
  googleClientId: string | null;
}

let configReady: Promise<PublicConfig> | undefined;

/** Chaves públicas do Turnstile e do Google, lidas do servidor uma vez por aba. */
function publicConfig(): Promise<PublicConfig> {
  return (configReady ??= request<PublicConfig>('/auth/config', 'GET')).catch((error: unknown) => {
    configReady = undefined;
    throw error;
  });
}

function loadScript(src: string, errorMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(errorMessage));
    document.head.append(script);
  });
}

const CAPTCHA_LOAD_ERROR = 'Não foi possível carregar a verificação contra robôs. Verifique a conexão e recarregue a página.';
let captchaReady: Promise<string | null> | undefined;

/** Carrega o Cloudflare Turnstile na primeira vez; sem chave configurada no servidor, segue sem token. */
function loadCaptcha(): Promise<string | null> {
  return (captchaReady ??= publicConfig().then(async ({ captchaSiteKey }) => {
    if (captchaSiteKey) await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', CAPTCHA_LOAD_ERROR);
    return captchaSiteKey;
  })).catch((error: unknown) => {
    captchaReady = undefined;
    throw error;
  });
}

interface GoogleIdentityServices {
  initialize(options: { client_id: string; callback: (response: { credential: string }) => void; ux_mode?: 'popup' }): void;
  renderButton(container: HTMLElement, options: Record<string, unknown>): void;
}

let googleReady: Promise<string | null> | undefined;

/**
 * Botão "Continuar com o Google" em `container`; o ID token vai para `onCredential`. Sem client ID configurado no servidor,
 * não mostra nada.
 */
export async function mountGoogleButton(container: HTMLElement, onCredential: (credential: string) => void): Promise<void> {
  const clientId = await (googleReady ??= publicConfig().then(async ({ googleClientId }) => {
    if (googleClientId) await loadScript('https://accounts.google.com/gsi/client', 'Não foi possível carregar o login com o Google.');
    return googleClientId;
  })).catch(() => {
    googleReady = undefined;
    return null;
  });
  if (!clientId || !container.isConnected) return;
  const google = (window as unknown as { google: { accounts: { id: GoogleIdentityServices } } }).google.accounts.id;
  google.initialize({ client_id: clientId, callback: ({ credential }) => onCredential(credential), ux_mode: 'popup' });
  google.renderButton(container, { theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'rectangular', locale: 'pt-BR', width: container.clientWidth || 320 });
}

const CAPTCHA_FAILED = 'Não conseguimos confirmar que você não é um robô. Recarregue a página e tente de novo.';

type CaptchaAction = 'signup' | 'login';

interface CaptchaWidget {
  id: string;
  action: CaptchaAction;
  token: Promise<string>;
  settle?: { resolve: (token: string) => void; reject: (error: Error) => void };
}

let widget: CaptchaWidget | undefined;

const turnstileApi = () => (window as unknown as { turnstile: Turnstile }).turnstile;

function awaitNextToken(target: CaptchaWidget): void {
  target.token = new Promise((resolve, reject) => (target.settle = { resolve, reject }));
  target.token.catch(() => {});
}

/** Widget no formulário, oculto até a Cloudflare pedir interação; sem chave configurada no servidor, não mostra nada. */
export async function mountCaptcha(container: HTMLElement, action: CaptchaAction): Promise<void> {
  const siteKey = await loadCaptcha().catch(() => null);
  unmountCaptcha();
  if (!siteKey || !container.isConnected) return;
  const target = { id: '', action } as CaptchaWidget;
  awaitNextToken(target);
  target.id = turnstileApi().render(container, {
    sitekey: siteKey,
    action,
    appearance: 'interaction-only',
    theme: 'dark',
    language: 'pt-br',
    callback: (token: string) => target.settle?.resolve(token),
    // A Cloudflare renova sozinha o token vencido e chama `callback` de novo.
    'expired-callback': () => awaitNextToken(target),
    'error-callback': () => target.settle?.reject(new Error(CAPTCHA_FAILED)),
  });
  widget = target;
}

export function unmountCaptcha(): void {
  if (widget) turnstileApi().remove(widget.id);
  widget = undefined;
}

/** Usa o token do widget e já pede outro: a Cloudflare aceita cada um uma vez só. */
async function captchaToken(action: CaptchaAction): Promise<{ captchaToken?: string }> {
  if (!(await loadCaptcha())) return {};
  const target = widget;
  if (target?.action !== action) throw new Error(CAPTCHA_LOAD_ERROR);
  try {
    return { captchaToken: await target.token };
  } finally {
    awaitNextToken(target);
    turnstileApi().reset(target.id);
  }
}

export const demoAuth = {
  signup: async (data: { name: string; email: string; company: string; password: string; privacyAccepted: boolean }) =>
    request<{ ok: true; message: string }>('/auth/signup', 'POST', { ...data, ...(await captchaToken('signup')) }),
  /** Conta com autenticador responde `totpRequired` até receber o código. */
  login: async (data: { email: string; password: string; code?: string }) =>
    request<{ ok: true } | { totpRequired: true }>('/auth/login', 'POST', { ...data, ...(await captchaToken('login')) }),
  /** Conta nova responde `signupRequired` até vir o aceite; conta com autenticador, `totpRequired` até vir o código. */
  google: (data: { credential: string; company?: string; privacyAccepted?: boolean; code?: string }) =>
    request<{ ok: true } | { totpRequired: true } | { signupRequired: true; name: string; email: string }>('/auth/google', 'POST', data),
};

export interface DemoAccountData {
  name: string;
  email: string;
  company: string | null;
}

/** "Meus dados": a conta da sessão edita ou apaga só a si mesma. */
export const demoAccount = {
  get: () => request<DemoAccountData & { hasPassword: boolean; totpEnabled: boolean }>('/auth/account', 'GET'),
  update: (data: DemoAccountData & { currentPassword: string; newPassword: string }) => request<{ ok: true; name: string }>('/auth/account', 'PATCH', data),
  /** Conta com senha confirma com ela; conta só do Google, com o próprio e-mail. */
  remove: (confirmation: { currentPassword: string } | { confirmEmail: string }) => request<{ ok: true }>('/auth/account', 'DELETE', confirmation),
  totpSecret: () => request<{ totpSecret: string }>('/auth/totp-secret', 'GET'),
  enableTotp: (secret: string, code: string) => request<{ ok: true }>('/auth/account/totp', 'POST', { secret, code }),
  disableTotp: (code: string) => request<{ ok: true }>('/auth/account/totp', 'DELETE', { code }),
};

/** Tela visitada ou ação: vai para o histórico que o Master vê em Logs da ferramenta. Falha não atrapalha a demo. */
function track(event: 'tela' | 'acao', detail: string): void {
  request('/activity', 'POST', { event, detail: detail.slice(0, 200) }).catch(() => {});
}

const PAGE_LABELS: Record<string, string> = {
  home: 'Início',
  'new-promotion': 'Nova promoção',
  recorrencias: 'Recorrências',
  aprendizado: 'Aprendizado',
  logs: 'Logs',
  'meus-dados': 'Meus dados',
  privacidade: 'Política de privacidade',
  monday: 'Conectores: Monday',
  dev: 'Promoção (Dev)',
  homolog: 'Promoção (Homolog)',
  producao: 'Promoção (Produção)',
};

void import('../router').then(({ router }) => {
  router.afterEach((to, from, failure) => {
    if (failure || to.name === 'login' || to.name === from.name && to.params.id === from.params.id) return;
    const page = PAGE_LABELS[String(to.name)] ?? to.path;
    track('tela', to.params.id ? `${page}: ${to.params.id}` : page);
  });
});

const SESSION_CHECK_INTERVAL_MS = 5_000;
let lastSessionCheck = 0;

/** Conta excluída ou desativada (Meus dados ou Contas da demo) cai na próxima interação: o resto da tela não fala com o servidor. */
export function onSessionExpired(handler: () => void): void {
  const check = () => {
    if (Date.now() - lastSessionCheck < SESSION_CHECK_INTERVAL_MS) return;
    lastSessionCheck = Date.now();
    request<{ authenticated: boolean }>('/auth/me', 'GET')
      .then((status) => {
        if (!status.authenticated) handler();
      })
      .catch(() => {});
  };
  for (const event of ['pointerdown', 'keydown']) document.addEventListener(event, check, { capture: true, passive: true });
}

const runTests: Api['runTests'] = async (id, env, _headed, group, quantity, onEvent, signal) => {
  findPromotion(id);
  await runFakeTests({ group, quantity, onEvent, signal, onStart: (run) => testRuns.set(`${id}:${env}`, run) });
};

const recurrencesScan: Api['recurrencesScan'] = async (_totpCode, onProgress, signal) => {
  const results = demoRecurrences(promotions);
  onProgress?.({ label: 'Consultando a API interna (simulado)...', current: 0, total: results.length });
  await wait(800, signal);
  for (const [index, promotion] of results.entries()) {
    await wait(600, signal);
    onProgress?.({ label: `Lendo ${promotion.name}...`, current: index + 1, total: results.length, promotion });
  }
  return { promotions: results };
};

const atendimentosScan: Api['atendimentosScan'] = async (target, _totpCode, onProgress, signal) => {
  const items = demoAtendimentos(target.promotionName);
  for (const [index, atendimento] of items.entries()) {
    await wait(350, signal);
    onProgress?.({ label: `Lendo atendimento ${index + 1} de ${items.length}...`, collected: index + 1, atendimento });
  }
  return { promotionName: target.promotionName, panelUrl: target.panelUrl, scannedAt: new Date().toISOString(), atendimentos: items };
};

const atendimentosSummary: Api['atendimentosSummary'] = async (promotionName, onProgress, signal) => {
  for (const percent of [20, 55, 85, 100]) {
    await wait(400, signal);
    onProgress(percent);
  }
  return demoSummary(promotionName);
};

const logs = demoLogs();
let logsLoaded = false;

/** Cada recarga da lista (Atualizar, filtro, abrir a tela de novo) sorteia execuções novas, como se a ferramenta tivesse rodado. */
function refreshLogs(): void {
  if (logsLoaded) logs.unshift(...randomDemoLogs(logs[0]!.id + 1));
  logsLoaded = true;
}

function filterLogs(filters: Parameters<Api['listLogs']>[1] = {}): StoredLog[] {
  return logs.filter((log) =>
    (filters.id === undefined || log.id === Number(filters.id))
    && (filters.before === undefined || log.id < Number(filters.before))
    && (filters.from === undefined || log.createdAt >= Number(filters.from))
    && (filters.to === undefined || log.createdAt < Number(filters.to))
    && (!filters.trigger || log.trigger === filters.trigger)
    && (!filters.userId || log.userId === filters.userId)
    && (!filters.onlyErrors || !log.ok));
}

const LOG_PAGE_SIZE = 50;

function updatePromotion(id: string, change: (promotion: PromotionConfig) => void): Promise<PromotionConfig> {
  const promotion = findPromotion(id);
  change(promotion);
  return Promise.resolve(structuredClone(promotion));
}

export const api: Api = {
  listAgencies: async () => DEMO_AGENCIES,
  listPromotions: async () => promotions.map(({ id, name, client, agencyId, stage }) => ({ id, name, client, agencyId, stage: stage ?? 'testing' })),
  setPromotionStage: async (id, stage: PromotionStage) => {
    findPromotion(id).stage = stage;
    return { stage };
  },
  getPromotion: async (id) => {
    const promotion = structuredClone(findPromotion(id));
    return {
      ...promotion,
      credentialValues: { dev: hiddenCredentials(), staging: hiddenCredentials(), production: hiddenCredentials() },
      panelSessionSaved: { dev: true, staging: true, production: true },
    };
  },
  createPromotion: async (data) => {
    const id = (data.slug || data.name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `promo-${promotions.length + 1}`;
    const created = { ...demoPromotions()[0]!, id, name: data.name, client: data.client, agencyId: data.agencyId, agencyName: data.agencyName, stage: 'testing' as const };
    promotions.push(created);
    return structuredClone(created);
  },
  saveDev: (id, data) => updatePromotion(id, (p) => {
    p.environments.site.dev = data.site;
    p.environments.adminPanel.dev = data.adminPanel;
  }),
  saveEnvironment: (id, env, data) => updatePromotion(id, (p) => {
    const key = ENV_KEY[env];
    p.environments.site[key] = data.site;
    p.environments.adminPanel[key] = data.adminPanel;
  }),
  saveMechanicsRules: (id, data) => updatePromotion(id, (p) => (p.mechanicsRules = data)),
  saveManualTestChecks: (id, env, checked) => updatePromotion(id, (p) => {
    p.manualTestChecks = { ...p.manualTestChecks, [ENV_KEY[env]]: checked };
  }),
  getLastTestRun: async (id, env: Env) => structuredClone(testRuns.get(`${id}:${env}`) ?? null),
  saveTestRunChecks: async (id, env, checks: ManualChecks) => {
    const run = testRuns.get(`${id}:${env}`);
    if (run) run.manualChecks = { ...checks };
    return { ok: true };
  },
  deletePromotion: fullVersionOnly,
  authenticatePanel: async () => ({ success: true }),
  authStatus: async () => {
    const status = await request<{ authenticated: boolean; id?: string; name?: string }>('/auth/me', 'GET');
    return { configured: true, ...status, role: status.authenticated ? 'tester' : undefined };
  },
  authSetup: fullVersionOnly,
  authSetupConfirm: fullVersionOnly,
  authLoginPassword: fullVersionOnly,
  authFirstAccess: fullVersionOnly,
  authFirstAccessConfirm: fullVersionOnly,
  authLogin: fullVersionOnly,
  authLogout: () => request<{ ok: true }>('/auth/logout', 'POST'),
  listUsers: fullVersionOnly,
  createUser: fullVersionOnly,
  deleteUser: fullVersionOnly,
  connectorsStatus: async () => ({ monday: true, promoMonitor: true, promoMonitorEmail: 'monitor@exemplo.com', promoMonitorHasTotpSecret: true, slack: false }),
  slackDisconnect: fullVersionOnly,
  slackDestinations: fullVersionOnly,
  slackSendMessage: fullVersionOnly,
  mondayDisconnect: fullVersionOnly,
  promoMonitorConnect: fullVersionOnly,
  promoMonitorDisconnect: fullVersionOnly,
  mondayBoards: async () => demoMonday.boards(),
  mondayBoardDetail: async (boardId) => demoMonday.boardDetail(boardId),
  mondayCreateGroup: async (boardId, name) => demoMonday.createGroup(boardId, name),
  mondayItems: async (boardId, groupId) => demoMonday.items(boardId, groupId),
  mondayCreateItem: async (boardId, data) => demoMonday.createItem(boardId, data),
  mondayItem: async (itemId) => demoMonday.item(itemId),
  mondayUpdateItem: async (itemId, data) => demoMonday.updateItem(itemId, data),
  mondayDeleteItem: async (itemId) => demoMonday.deleteItem(itemId),
  mondayUsers: async () => demoMonday.users(),
  mondayItemUpdates: async (itemId) => demoMonday.itemUpdates(itemId),
  mondayPostUpdate: async (itemId, body) => demoMonday.postUpdate(itemId, body),
  mondayPostChecklistUpdate: async (itemId, data) => demoMonday.postChecklistUpdate(itemId, data),
  mondaySubitems: async (itemId) => demoMonday.subitems(itemId),
  mondayCreateSubitem: async (itemId, name) => demoMonday.createSubitem(itemId, name),
  recurrencesScan,
  recurrencesRefresh: async (signal) => {
    await wait(500, signal);
    accessBump += 7;
    return demoRecurrences(promotions).map(({ name }, index) => ({ name, analyticsCount: (1200 + index * 873 + accessBump).toLocaleString('pt-BR') }));
  },
  recurrencesWhatsApp: fullVersionOnly,
  recurrencesMessage: async () =>
    ['*Recorrências (demonstração)*', ...demoRecurrences(promotions).map((p) => `${p.ok ? '✅' : '⚠️'} ${p.name}${p.failingLines.length ? `: ${p.failingLines.join('; ')}` : ''}`)].join('\n'),
  recurrencesSchedule: async () => ({ ...schedule }),
  setRecurrencesSchedule: async (enabled) => (schedule = { ...schedule, enabled }),
  atendimentosScan,
  atendimentosSummary,
  atendimentoLabels: async () => [],
  saveAtendimentoLabel: async (data) => ({ atendimentoId: data.atendimentoId, severity: data.severity, tema: data.tema }),
  getLearningStatus: async () => ({
    total: 48,
    bySeverity: { critica: 9, alta: 11, media: 13, baixa: 8, externo: 7 },
    trained: ['critica', 'alta', 'media'],
    minLabels: 30,
    minPerSeverity: 8,
    lastUpdatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  }),
  exportLearning: fullVersionOnly,
  importLearning: fullVersionOnly,
  listLogs: async (_source, filters = {}) => {
    if (filters.before === undefined) refreshLogs();
    const page = filterLogs(filters);
    return { logs: page.slice(0, LOG_PAGE_SIZE), hasMore: page.length > LOG_PAGE_SIZE };
  },
  listLogUsers: async () => demoLogUsers(),
  listDemoAccounts: fullVersionOnly,
  setDemoAccountDisabled: fullVersionOnly,
  deleteDemoAccount: fullVersionOnly,
  listDemoAccountEvents: fullVersionOnly,
  runTests,
  listTestGroups: async (id) => {
    findPromotion(id);
    return {
      groups: TEST_GROUPS.map((g) => ({ id: g.id, label: g.label, available: true, manualTests: g.manualTests ?? [] })),
      massRegistration: { groups: MASS_REGISTRATION_GROUPS.map(({ id: groupId, label }) => ({ id: groupId, label })), limits: MASS_REGISTRATION_LIMITS },
    };
  },
};

const ENV_LABELS: Record<Env, string> = { dev: 'Dev', homolog: 'Homolog', producao: 'Produção' };

const ACTIONS: { [K in keyof Api]?: (...args: Parameters<Api[K]>) => string } = {
  runTests: (id, env, _headed, group, quantity) => `Rodou testes${group ? ` do grupo ${group}` : ''}${quantity ? ` (${quantity})` : ''} em ${id} / ${ENV_LABELS[env]}`,
  createPromotion: (data) => `Criou a promoção ${data.name}`,
  setPromotionStage: (id, stage) => `Mudou a etapa de ${id} para ${stage}`,
  saveDev: (id) => `Salvou Dev de ${id}`,
  saveEnvironment: (id, env) => `Salvou ${ENV_LABELS[env]} de ${id}`,
  saveMechanicsRules: (id) => `Salvou a mecânica de ${id}`,
  saveManualTestChecks: (id, env) => `Marcou testes manuais em ${id} / ${ENV_LABELS[env]}`,
  saveTestRunChecks: (id, env) => `Revisou a rodada de ${id} / ${ENV_LABELS[env]}`,
  authenticatePanel: (id, env) => `Autenticou o painel de ${id} / ${ENV_LABELS[env]}`,
  recurrencesScan: () => 'Leu as recorrências',
  recurrencesMessage: () => 'Abriu o envio ao Slack',
  setRecurrencesSchedule: (enabled) => `${enabled ? 'Ligou' : 'Desligou'} o agendamento das recorrências`,
  atendimentosScan: (target) => `Leu os atendimentos de ${target.promotionName}`,
  atendimentosSummary: (promotionName) => `Gerou o resumo dos atendimentos de ${promotionName}`,
  saveAtendimentoLabel: (data) => `Corrigiu a gravidade de um atendimento para ${data.severity}`,
  mondayCreateItem: (_boardId, data) => `Criou o item "${data.name}" no Monday fictício`,
  mondayPostUpdate: () => 'Comentou num item do Monday fictício',
};

for (const [key, describe] of Object.entries(ACTIONS) as [keyof Api, (...args: unknown[]) => string][]) {
  const original = api[key] as (...args: unknown[]) => unknown;
  (api as Record<keyof Api, unknown>)[key] = (...args: unknown[]) => {
    track('acao', describe(...args));
    return original(...args);
  };
}

// Recurso só da versão completa: mostra ao Master o que o visitante procurou.
for (const key of Object.keys(api) as (keyof Api)[]) {
  if (api[key] !== fullVersionOnly) continue;
  (api as Record<keyof Api, unknown>)[key] = () => {
    track('acao', `Tentou usar ${key} (só na versão completa)`);
    return fullVersionOnly();
  };
}
