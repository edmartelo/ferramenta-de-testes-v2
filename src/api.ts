import type { MechanicsRules, PromotionConfig, PromotionStage } from '../promotions/types';
import type {
  AtendimentosScanEvent,
  AtendimentosScanResult,
  AuthenticatePanelEvent,
  RecurrencesAccessCount,
  RecurrencesPromotionResult,
  RecurrencesRefreshEvent,
  RecurrencesScanEvent,
  TestRunEvent,
} from '../server/test-runner';
import type { ManualChecks, ManualCheckState, StoredTestRun } from '../server/test-runs';
import type { AtendimentosSummary, AtendimentosSummaryEvent, Severity } from '../server/atendimentos-summary';
import type { ScheduleStatus } from '../server/recurrences-schedule';
import type { LearningFile, LearningStatus } from '../server/learning-api';
import type { LabelImportResult } from '../server/atendimento-labels';
import type { UserRole, UserSummary } from '../server/auth';
import type { LogFilters, LogSource, LogTrigger, LogUser, StoredLog } from '../server/logs';
import type { DemoAccount, DemoAccountEventFilters, DemoAccountEventLog } from '../server/demo-accounts-api';
import type { DemoAccountEvent } from '../server/demo/schema';

export type { Atendimento, AtendimentosScanResult } from '../server/test-runner';
export type { AtendimentosSummary, Severity } from '../server/atendimentos-summary';
export type { ManualChecks, ManualCheckState, MechanicsRules, RecurrencesPromotionResult, StoredTestRun, TestRunEvent };
export type { DemoAccount, DemoAccountEvent, DemoAccountEventFilters, DemoAccountEventLog, LearningStatus, LogFilters, LogSource, LogTrigger, LogUser, StoredLog, UserRole, UserSummary };

export interface AtendimentoLabelValue {
  atendimentoId: string;
  severity: Severity;
  tema: string | null;
}

export interface PromotionSummary {
  id: string;
  name: string;
  client: string;
  agencyId: string;
  stage: PromotionStage;
}

export interface TestGroupSummary {
  id: string;
  label: string;
  available: boolean;
  manualTests: { id: string; label: string }[];
}

export interface MassRegistrationSummary {
  groups: { id: string; label: string }[];
  /** Por chave de config (`dev`/`staging`/`production`); ambiente ausente não tem cadastro em massa. */
  limits: Partial<Record<'dev' | 'staging' | 'production', number>>;
}

export interface AgencySummary {
  id: string;
  name: string;
}

interface CredentialValues {
  adminPanelUser?: string;
  adminPanelPassword?: string;
  adminPanelTotpSecret?: string;
  testParticipantCpf?: string;
  testParticipantPassword?: string;
  recaptchaSiteKey?: string;
  recaptchaSecretKey?: string;
}

export interface MondayWorkspaceBoards {
  workspace: { id: string; name: string };
  boards: { id: string; name: string }[];
}

export interface MondayColumn {
  id: string;
  title: string;
  type: string;
  editable: boolean;
  options?: { id: string; label: string; color?: string }[];
}

export interface MondayGroup {
  id: string;
  title: string;
  color?: string;
}

export interface MondayBoardDetail {
  columns: MondayColumn[];
  groups: MondayGroup[];
}

export interface MondayItemColumnValue {
  columnId: string;
  text: string | null;
  value: unknown;
}

export interface MondayItem {
  id: string;
  name: string;
  columnValues: MondayItemColumnValue[];
}

interface MondayItemsPage {
  cursor: string | null;
  items: MondayItem[];
}

export interface SlackDestinations {
  channels: { id: string; name: string; private: boolean }[];
  users: { id: string; name: string; photo?: string }[];
}

export interface MondayUser {
  id: string;
  name: string;
  photo_thumb_small: string | null;
}

export interface MondaySubitem {
  id: string;
  name: string;
  boardId: string;
}

export interface MondayUpdate {
  id: string;
  text_body: string;
  created_at: string;
  creator: { name: string } | null;
}

interface PromotionDetail extends PromotionConfig {
  credentialValues: { dev: CredentialValues; staging: CredentialValues; production: CredentialValues };
  /** Só diz que já autenticou alguma vez, não que a sessão do painel ainda é válida. */
  panelSessionSaved: { dev: boolean; staging: boolean; production: boolean };
}

let sessionExpiredHandler: (() => void) | undefined;

export function onSessionExpired(handler: () => void): void {
  sessionExpiredHandler = handler;
}

/** Conectores também respondem 401 (token do Monday), então confirma em /auth/status antes de deslogar. */
async function checkSessionExpired(path: string): Promise<void> {
  if (!sessionExpiredHandler || path.startsWith('/auth/')) return;
  const status = await fetch('/api/auth/status').then((r) => r.json()).catch(() => undefined);
  if (status && !status.authenticated) sessionExpiredHandler();
}

async function throwIfNotOk(res: Response, path: string, fallback: string): Promise<void> {
  if (res.ok) return;
  if (res.status === 401) await checkSessionExpired(path);
  const body = await res.json().catch(() => ({}));
  throw new Error(body.error ?? fallback);
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  await throwIfNotOk(res, path, `Erro ${res.status} em ${path}`);
  return res.json() as Promise<T>;
}

function send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<T> {
  return request<T>(path, { method, body: data === undefined ? undefined : JSON.stringify(data) });
}

const post = <T>(path: string, data?: unknown) => send<T>('POST', path, data);
const put = <T>(path: string, data: unknown) => send<T>('PUT', path, data);
const patch = <T>(path: string, data: unknown) => send<T>('PATCH', path, data);
const del = <T>(path: string) => send<T>('DELETE', path);

async function* streamNdjson<T>(path: string, data: unknown, fallbackError: string, signal?: AbortSignal): AsyncGenerator<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  });
  await throwIfNotOk(res, path, `Erro ${res.status} ${fallbackError}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line) as T;
    }
  }
}

const CONNECTION_CLOSED = 'Conexão encerrada sem confirmação do resultado.';

export const api = {
  listAgencies: () => request<AgencySummary[]>('/agencies'),
  listPromotions: () => request<PromotionSummary[]>('/promotions'),
  setPromotionStage: (id: string, stage: PromotionStage) => put<{ stage: PromotionStage }>(`/promotions/${id}/stage`, { stage }),
  getPromotion: (id: string) => request<PromotionDetail>(`/promotions/${id}`),
  createPromotion: (data: { name: string; client: string; agencyId: string; agencyName?: string; slug?: string }) => post<PromotionConfig>('/promotions', data),
  saveDev: (
    id: string,
    data: { backend: string; frontend: string; site?: string; adminPanel?: string } & Omit<CredentialValues, 'testParticipantCpf' | 'testParticipantPassword'>,
  ) => put<PromotionConfig>(`/promotions/${id}/dev`, data),
  saveEnvironment: (
    id: string,
    env: 'homolog' | 'producao',
    data: { site: string; adminPanel: string } & CredentialValues,
  ) => put<PromotionConfig>(`/promotions/${id}/${env}`, data),
  saveMechanicsRules: (id: string, data: MechanicsRules) => put<PromotionConfig>(`/promotions/${id}/mechanics-rules`, data),
  saveManualTestChecks: (id: string, env: 'homolog' | 'producao', checked: string[]) =>
    put<PromotionConfig>(`/promotions/${id}/manual-tests`, { env, checked }),
  getLastTestRun: (id: string, env: 'dev' | 'homolog' | 'producao') => request<StoredTestRun | null>(`/promotions/${id}/test-run?env=${env}`),
  saveTestRunChecks: (id: string, env: 'dev' | 'homolog' | 'producao', checks: ManualChecks) =>
    put<{ ok: true }>(`/promotions/${id}/test-run-checks`, { env, checks }),
  deletePromotion: (id: string) => del<{ ok: true }>(`/promotions/${id}`),
  authenticatePanel,
  authStatus: () => request<{ configured: boolean; authenticated: boolean; id?: string; name?: string; role?: UserRole }>('/auth/status'),
  authSetup: (data: { name: string; email: string; password: string }) => post<{ totpSecret: string }>('/auth/setup', data),
  authSetupConfirm: (data: { name: string; email: string; password: string; totpSecret: string; code: string }) =>
    post<{ ok: true }>('/auth/setup/confirm', data),
  authLoginPassword: (data: { email: string; password: string }) => post<{ ok: true; setupRequired: boolean }>('/auth/login/password', data),
  authFirstAccess: (data: { email: string; password: string; newPassword: string }) => post<{ totpSecret: string }>('/auth/first-access', data),
  authFirstAccessConfirm: (data: { email: string; password: string; newPassword: string; totpSecret: string; code: string }) =>
    post<{ ok: true }>('/auth/first-access/confirm', data),
  authLogin: (data: { email: string; password: string; code: string }) => post<{ ok: true }>('/auth/login', data),
  authLogout: () => post<{ ok: true }>('/auth/logout'),
  listUsers: () => request<UserSummary[]>('/users'),
  createUser: (data: { email: string; password: string; role: UserRole }) => post<UserSummary[]>('/users', data),
  deleteUser: (id: string) => del<UserSummary[]>(`/users/${id}`),
  connectorsStatus: () =>
    request<{ monday: boolean; promoMonitor: boolean; promoMonitorEmail?: string; promoMonitorHasTotpSecret: boolean; slack: boolean; slackTeamName?: string }>(
      '/connectors/status',
    ),
  slackDisconnect: () => post<{ ok: true }>('/connectors/slack/disconnect'),
  slackDestinations: () => request<SlackDestinations>('/connectors/slack/destinations'),
  slackSendMessage: (data: { destination: string; text: string; logSource?: LogSource; destinationName?: string }) => post<{ ok: true; permalink: string | null }>('/connectors/slack/messages', data),
  mondayDisconnect: () => post<{ ok: true }>('/connectors/monday/disconnect'),
  promoMonitorConnect: (data: { email: string; password: string; totpSecret?: string }) => post<{ ok: true }>('/connectors/promo-monitor', data),
  promoMonitorDisconnect: () => post<{ ok: true }>('/connectors/promo-monitor/disconnect'),
  mondayBoards: () => request<MondayWorkspaceBoards[]>('/connectors/monday/boards'),
  mondayBoardDetail: (boardId: string) => request<MondayBoardDetail>(`/connectors/monday/boards/${boardId}`),
  mondayCreateGroup: (boardId: string, name: string) => post<MondayGroup>(`/connectors/monday/boards/${boardId}/groups`, { name }),
  mondayItems: (boardId: string, groupId: string, cursor?: string | null) =>
    request<MondayItemsPage>(`/connectors/monday/boards/${boardId}/items?groupId=${encodeURIComponent(groupId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  mondayCreateItem: (boardId: string, data: { name: string; groupId?: string; columnValues?: Record<string, unknown>; updateText?: string }) =>
    post<{ id: string; name: string; updateWarning?: string }>(`/connectors/monday/boards/${boardId}/items`, data),
  mondayItem: (itemId: string, boardId: string) => request<MondayItem>(`/connectors/monday/items/${itemId}?boardId=${encodeURIComponent(boardId)}`),
  mondayUpdateItem: (itemId: string, data: { boardId: string; name?: string; columnValues?: Record<string, unknown> }) =>
    patch<{ id: string; name: string }>(`/connectors/monday/items/${itemId}`, data),
  mondayDeleteItem: (itemId: string) => del<{ ok: true }>(`/connectors/monday/items/${itemId}`),
  mondayUsers: () => request<MondayUser[]>('/connectors/monday/users'),
  mondayItemUpdates: (itemId: string) => request<MondayUpdate[]>(`/connectors/monday/items/${itemId}/updates`),
  mondayPostUpdate: (itemId: string, body: string) => post<{ id: string }>(`/connectors/monday/items/${itemId}/updates`, { body }),
  mondayPostChecklistUpdate: (itemId: string, data: { boardId: string; title: string; tasks: string[]; userIds: string[]; assignColumnId: string }) =>
    post<{ id: string; url: string | null }>(`/connectors/monday/items/${itemId}/checklist-update`, data),
  mondaySubitems: (itemId: string) => request<MondaySubitem[]>(`/connectors/monday/items/${itemId}/subitems`),
  mondayCreateSubitem: (itemId: string, name: string) => post<{ ok: true }>(`/connectors/monday/items/${itemId}/subitems`, { name }),
  recurrencesScan,
  recurrencesRefresh,
  recurrencesWhatsApp,
  recurrencesMessage: async (summaryPromotions?: string[]) =>
    (await post<{ text: string }>('/recurrences/message', summaryPromotions ? { summaryPromotions } : {})).text,
  recurrencesSchedule: () => request<ScheduleStatus>('/recurrences/schedule'),
  setRecurrencesSchedule: (enabled: boolean) => send<ScheduleStatus>('PUT', '/recurrences/schedule', { enabled }),
  atendimentosScan,
  atendimentosSummary,
  atendimentoLabels: (promotionName: string) =>
    request<AtendimentoLabelValue[]>(`/recurrences/atendimento-labels?promotionName=${encodeURIComponent(promotionName)}`),
  saveAtendimentoLabel: (data: { promotionName: string } & AtendimentoLabelValue) => put<AtendimentoLabelValue>('/recurrences/atendimento-labels', data),
  getLearningStatus: () => request<LearningStatus>('/learning'),
  exportLearning: () => request<LearningFile>('/learning/export'),
  importLearning: (file: unknown) => post<LabelImportResult & { status: LearningStatus }>('/learning/import', file),
  listLogs: (source: LogSource, filters: LogFilters = {}) => {
    const params = new URLSearchParams({ source });
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === '' || value === false) continue;
      params.set(key, value === true ? '1' : String(value));
    }
    return request<{ logs: StoredLog[]; hasMore: boolean }>(`/logs?${params}`);
  },
  listLogUsers: (source: LogSource) => request<LogUser[]>(`/logs/users?source=${source}`),
  listDemoAccounts: (range: { from?: number; to?: number } = {}) => {
    const params = new URLSearchParams(Object.entries(range).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return request<DemoAccount[]>(`/demo-accounts?${params}`);
  },
  setDemoAccountDisabled: (id: string, disabled: boolean) => patch<{ ok: true }>(`/demo-accounts/${id}`, { disabled }),
  deleteDemoAccount: (id: string) => del<{ ok: true }>(`/demo-accounts/${id}`),
  listDemoAccountEvents: (filters: DemoAccountEventFilters = {}) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)]));
    return request<{ events: DemoAccountEventLog[]; hasMore: boolean }>(`/demo-accounts/events?${params}`);
  },
  runTests,
  listTestGroups: (id: string) => request<{ groups: TestGroupSummary[]; massRegistration: MassRegistrationSummary }>(`/promotions/${id}/test-groups`),
};

/** `totpCode` `undefined` = chave base32 salva, o servidor gera o código. */
async function authenticatePanel(
  id: string,
  env: 'dev' | 'homolog' | 'producao',
  totpCode: string | undefined,
  signal?: AbortSignal,
): Promise<{ success: boolean; error?: string }> {
  const events = streamNdjson<AuthenticatePanelEvent>(`/promotions/${id}/authenticate-panel`, { env, totpCode }, 'ao autenticar no painel.', signal);
  for await (const event of events) return event;
  return { success: false, error: CONNECTION_CLOSED };
}

type RecurrencesScanProgress = Omit<Extract<RecurrencesScanEvent, { type: 'progress' }>, 'type'>;

async function recurrencesScan(
  totpCode: string | undefined,
  onProgress?: (progress: RecurrencesScanProgress) => void,
  signal?: AbortSignal,
): Promise<{ promotions: RecurrencesPromotionResult[] }> {
  for await (const event of streamNdjson<RecurrencesScanEvent>('/recurrences/scan', { totpCode }, 'ao consultar recorrências.', signal)) {
    if (event.type === 'progress') onProgress?.(event);
    else if (event.success) return { promotions: event.promotions };
    else throw new Error(event.error);
  }
  throw new Error(CONNECTION_CLOSED);
}

async function recurrencesRefresh(signal?: AbortSignal): Promise<RecurrencesAccessCount[]> {
  for await (const event of streamNdjson<RecurrencesRefreshEvent>('/recurrences/refresh', {}, 'ao atualizar a contagem de acessos.', signal)) {
    if (event.success) return event.counts;
    throw new Error(event.error);
  }
  throw new Error(CONNECTION_CLOSED);
}

async function recurrencesWhatsApp(signal?: AbortSignal, summaryPromotions?: string[]): Promise<void> {
  await request('/recurrences/whatsapp', { method: 'POST', signal, body: summaryPromotions ? JSON.stringify({ summaryPromotions }) : undefined });
}

async function atendimentosScan(
  target: { promotionName: string; panelUrl: string },
  totpCode: string | undefined,
  onProgress?: (progress: Omit<Extract<AtendimentosScanEvent, { type: 'progress' }>, 'type'>) => void,
  signal?: AbortSignal,
): Promise<AtendimentosScanResult> {
  for await (const event of streamNdjson<AtendimentosScanEvent>('/recurrences/atendimentos', { ...target, totpCode }, 'ao coletar atendimentos.', signal)) {
    if (event.type === 'progress') onProgress?.(event);
    else if (event.success) return event;
    else throw new Error(event.error);
  }
  throw new Error(CONNECTION_CLOSED);
}

async function atendimentosSummary(
  promotionName: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<AtendimentosSummary> {
  for await (const event of streamNdjson<AtendimentosSummaryEvent>('/recurrences/atendimentos-summary', { promotionName }, 'ao analisar atendimento(s).', signal)) {
    if (event.type === 'progress') onProgress(event.percent);
    else if (event.success) return event;
    else throw new Error(event.error);
  }
  throw new Error(CONNECTION_CLOSED);
}

async function runTests(
  id: string,
  env: 'dev' | 'homolog' | 'producao',
  headed: boolean,
  group: string | undefined,
  quantity: number | undefined,
  onEvent: (event: TestRunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  for await (const event of streamNdjson<TestRunEvent>(`/promotions/${id}/run-tests`, { env, headed, group, quantity }, 'ao rodar os testes.', signal)) {
    onEvent(event);
    if (event.type === 'end') {
      if (!event.success) throw new Error(event.error);
      return;
    }
  }
  throw new Error(CONNECTION_CLOSED);
}
