import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { getAuthenticatedUserId } from './auth.ts';
import { readJsonBody, sendJson } from './http-utils.ts';
import { LOG_SOURCES, recordLog, type LogSource } from './logs.ts';
import { readJsonFile, writeJsonFile } from '../src/lib/json-file.ts';
import { PROJECT_ROOT } from '../src/lib/paths.ts';
import { rootEnv } from '../src/lib/root-env.ts';
import { generateTotpCode } from '../src/lib/totp.ts';

const CONNECTORS_FILE_PATH = join(PROJECT_ROOT, '.connectors.json');

interface MondayConnection {
  accessToken: string;
  accountName?: string;
  connectedAt: string;
}

export interface PromoMonitorConnection {
  email: string;
  password: string;
  totpSecret?: string;
  /** Hostname → chave do Authenticator, pros painéis com 2FA próprio (não o do Monitor). */
  panelTotpSecrets?: Record<string, string>;
  connectedAt: string;
}

interface SlackConnection {
  accessToken: string;
  teamName?: string;
  connectedAt: string;
}

interface UserConnectors {
  monday?: MondayConnection;
  promoMonitor?: PromoMonitorConnection;
  slack?: SlackConnection;
}

function readConnectorsFile(): Record<string, UserConnectors> {
  return readJsonFile<Record<string, UserConnectors>>(CONNECTORS_FILE_PATH, {});
}

function getUserConnectors(userId: string): UserConnectors {
  return readConnectorsFile()[userId] ?? {};
}

/** `undefined` no patch desconecta aquele conector. */
function updateUserConnectors(userId: string, patch: UserConnectors): void {
  const all = readConnectorsFile();
  if (!all[userId] && Object.values(patch).every((value) => value === undefined)) return;
  all[userId] = { ...all[userId], ...patch };
  writeJsonFile(CONNECTORS_FILE_PATH, all);
}

export function getPromoMonitorConnection(userId: string): PromoMonitorConnection | undefined {
  return getUserConnectors(userId).promoMonitor;
}

// `state` do OAuth (anti-CSRF).
const PENDING_STATE_TTL_MS = 5 * 60 * 1000;
const pendingStates = new Map<string, { userId: string; appOrigin: string; expiresAt: number }>();

function createPendingState(userId: string, appOrigin: string): string {
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, { userId, appOrigin, expiresAt: Date.now() + PENDING_STATE_TTL_MS });
  return state;
}

function consumePendingState(state: string | null): { userId: string; appOrigin: string } | undefined {
  if (!state) return undefined;
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry;
}

function appOrigin(req: IncomingMessage): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
  return `${proto}://${req.headers.host}`;
}

function mondayRedirectUri(req: IncomingMessage): string {
  return `${appOrigin(req)}/api/connectors/monday/callback`;
}

/** O Slack pode recusar redirect sem HTTPS: `SLACK_REDIRECT_URI` aponta pra um túnel HTTPS até este servidor. */
function slackRedirectUri(req: IncomingMessage): string {
  return rootEnv('SLACK_REDIRECT_URI') || `${appOrigin(req)}/api/connectors/slack/callback`;
}

const API_TIMEOUT_MS = 30_000;

/** O prazo vale até o fim do corpo: o `res.json()` também é abortado. */
async function fetchJson(service: string, url: string, init: RequestInit): Promise<{ res: Response; json: any }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    return { res, json: await res.json() };
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`${service} não respondeu em ${API_TIMEOUT_MS / 1000} s.`);
    throw error;
  }
}

const SLACK_USER_SCOPES = 'chat:write channels:read groups:read mpim:read im:write users:read';
const SLACK_AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);
const SLACK_PAGE_LIMIT = 10;

class SlackApiError extends Error {
  constructor(message: string, public readonly isAuthError: boolean) {
    super(message);
  }
}

async function slackApi<T>(token: string | undefined, method: string, params: Record<string, string>): Promise<T> {
  const { res, json } = await fetchJson(`Slack (${method})`, `https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: new URLSearchParams(params),
  });
  if (!json.ok) {
    const code = String(json.error ?? `http_${res.status}`);
    throw new SlackApiError(`Slack recusou ${method}: ${code}.`, SLACK_AUTH_ERRORS.has(code));
  }
  return json as T;
}

async function slackPaginated<T>(token: string, method: string, params: Record<string, string>, key: string): Promise<T[]> {
  const all: T[] = [];
  let cursor = '';
  for (let page = 0; page < SLACK_PAGE_LIMIT; page++) {
    const json = await slackApi<Record<string, unknown> & { response_metadata?: { next_cursor?: string } }>(token, method, {
      ...params,
      limit: '200',
      ...(cursor ? { cursor } : {}),
    });
    all.push(...((json[key] as T[] | undefined) ?? []));
    cursor = json.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return all;
}

const MONDAY_SCOPES = 'boards:read boards:write workspaces:read me:read updates:read updates:write users:read';

const HIDDEN_MONDAY_NAMES = new Set(['kanban team', 'área de trabalho principal']);
const isHiddenMondayName = (name: string) => HIDDEN_MONDAY_NAMES.has(name.trim().toLocaleLowerCase('pt-BR'));

class MondayApiError extends Error {
  constructor(message: string, public readonly isAuthError: boolean) {
    super(message);
  }
}

async function mondayGraphQL<T>(token: string, query: string, variables?: Record<string, unknown>, apiVersion?: string): Promise<T> {
  const { res, json } = await fetchJson('Monday', 'https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, ...(apiVersion ? { 'API-Version': apiVersion } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || json.errors?.length) {
    const message = json.errors?.[0]?.message ?? `Erro ${res.status} na API do Monday.`;
    throw new MondayApiError(message, res.status === 401);
  }
  return json.data as T;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Fecha o popup de OAuth e avisa a SPA via `postMessage`. */
function sendPopupCloseHtml(
  res: ServerResponse,
  payload: { ok: boolean; error?: string },
  connector: 'monday' | 'slack' = 'monday',
  targetOrigin?: string,
): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><body>
<p>${payload.ok ? 'Conectado! Pode fechar esta janela.' : `Falha: ${escapeHtml(String(payload.error ?? ''))}`}</p>
<script>
  var payload = ${JSON.stringify(payload).replace(/</g, '\\u003c')};
  if (window.opener) {
    window.opener.postMessage(Object.assign({ source: 'ft-connectors', connector: ${JSON.stringify(connector)} }, payload), ${targetOrigin ? JSON.stringify(targetOrigin).replace(/</g, '\\u003c') : 'window.location.origin'});
  }
  window.close();
</script>
</body></html>`);
}

/** Token inválido/expirado vira 401 (e limpa a conexão salva); outro erro da API, 502. */
async function withMonday(userId: string, res: ServerResponse, run: (accessToken: string) => Promise<void>): Promise<void> {
  const connection = getUserConnectors(userId).monday;
  if (!connection) {
    sendJson(res, 401, { error: 'Monday não conectado.' });
    return;
  }
  try {
    await run(connection.accessToken);
  } catch (error) {
    if (error instanceof MondayApiError && error.isAuthError) updateUserConnectors(userId, { monday: undefined });
    sendJson(res, error instanceof MondayApiError && error.isAuthError ? 401 : 502, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function withSlack(userId: string, res: ServerResponse, run: (accessToken: string) => Promise<void>): Promise<void> {
  const connection = getUserConnectors(userId).slack;
  if (!connection) {
    sendJson(res, 401, { error: 'Slack não conectado. Conecte em Configurações → Conectores → Slack.' });
    return;
  }
  try {
    await run(connection.accessToken);
  } catch (error) {
    if (error instanceof SlackApiError && error.isAuthError) updateUserConnectors(userId, { slack: undefined });
    sendJson(res, error instanceof SlackApiError && error.isAuthError ? 401 : 502, { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Fora do `requireAuth`: com `SLACK_REDIRECT_URI` num túnel HTTPS, o cookie de sessão não chega; o `state` é que liga ao usuário. */
export async function handleSlackOAuthCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== 'GET' || url.pathname !== '/api/connectors/slack/callback') return false;
  const pending = consumePendingState(url.searchParams.get('state'));
  const code = url.searchParams.get('code');
  if (!pending || !code) {
    sendPopupCloseHtml(res, { ok: false, error: url.searchParams.get('error') ?? 'Autorização inválida ou expirada.' }, 'slack', pending?.appOrigin);
    return true;
  }
  const clientId = rootEnv('SLACK_CLIENT_ID');
  const clientSecret = rootEnv('SLACK_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    sendPopupCloseHtml(res, { ok: false, error: 'SLACK_CLIENT_ID/SLACK_CLIENT_SECRET não configurados no .env raiz.' }, 'slack', pending.appOrigin);
    return true;
  }
  try {
    const token = await slackApi<{ authed_user?: { access_token?: string }; team?: { name?: string } }>(undefined, 'oauth.v2.access', {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: slackRedirectUri(req),
    });
    const accessToken = token.authed_user?.access_token;
    if (!accessToken) throw new Error('Slack não devolveu token de usuário.');
    updateUserConnectors(pending.userId, { slack: { accessToken, teamName: token.team?.name, connectedAt: new Date().toISOString() } });
    sendPopupCloseHtml(res, { ok: true }, 'slack', pending.appOrigin);
  } catch (error) {
    sendPopupCloseHtml(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 'slack', pending.appOrigin);
  }
  return true;
}

interface SlackChannel {
  id: string;
  name?: string;
  is_private?: boolean;
  is_mpim?: boolean;
  purpose?: { value?: string };
}

interface SlackUser {
  id: string;
  name: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { real_name?: string; display_name?: string; image_24?: string };
}

const SLACK_DESTINATION_PATTERN = /^[CGDU][A-Z0-9]{2,}$/;
const SLACK_MAX_TEXT_LENGTH = 40_000;

async function handleSlackRoute(req: IncomingMessage, res: ServerResponse, pathname: string, userId: string): Promise<boolean> {
  if (req.method === 'GET' && pathname === '/api/connectors/slack/authorize') {
    const clientId = rootEnv('SLACK_CLIENT_ID');
    if (!clientId) {
      return sendJson(res, 400, { error: 'SLACK_CLIENT_ID não configurado no .env raiz.' });
    }
    const authorizeUrl = new URL('https://slack.com/oauth/v2/authorize');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('user_scope', SLACK_USER_SCOPES);
    authorizeUrl.searchParams.set('redirect_uri', slackRedirectUri(req));
    authorizeUrl.searchParams.set('state', createPendingState(userId, appOrigin(req)));
    res.statusCode = 302;
    res.setHeader('Location', authorizeUrl.toString());
    res.end();
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/connectors/slack/disconnect') {
    updateUserConnectors(userId, { slack: undefined });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/connectors/slack/destinations') {
    await withSlack(userId, res, async (token) => {
      const [channels, users] = await Promise.all([
        slackPaginated<SlackChannel>(token, 'users.conversations', { types: 'public_channel,private_channel,mpim', exclude_archived: 'true' }, 'channels'),
        slackPaginated<SlackUser>(token, 'users.list', {}, 'members'),
      ]);
      sendJson(res, 200, {
        channels: channels
          .map((channel) => ({
            id: channel.id,
            name: channel.is_mpim ? channel.purpose?.value || channel.name || channel.id : channel.name ?? channel.id,
            private: Boolean(channel.is_private || channel.is_mpim),
          }))
          .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
        users: users
          .filter((user) => !user.deleted && !user.is_bot && user.id !== 'USLACKBOT')
          .map((user) => ({ id: user.id, name: user.profile?.real_name || user.profile?.display_name || user.name, photo: user.profile?.image_24 }))
          .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
      });
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/connectors/slack/messages') {
    const body = (await readJsonBody(req)) as { destination?: string; text?: string; logSource?: string; destinationName?: string };
    const destination = String(body.destination ?? '');
    const logSource = LOG_SOURCES.find((source): source is LogSource => source === body.logSource);
    const text = String(body.text ?? '').trim();
    if (!SLACK_DESTINATION_PATTERN.test(destination)) return sendJson(res, 400, { error: 'Destinatário do Slack inválido.' });
    if (!text) return sendJson(res, 400, { error: 'Mensagem vazia.' });
    if (text.length > SLACK_MAX_TEXT_LENGTH) return sendJson(res, 400, { error: `Mensagem passa de ${SLACK_MAX_TEXT_LENGTH} caracteres.` });
    const details = {
      destino: destination.startsWith('U') ? 'mensagem direta' : 'canal',
      ...(body.destinationName && { nomeDoDestino: String(body.destinationName).slice(0, 100) }),
    };
    const log = (ok: boolean, message: string) => logSource && recordLog({ source: logSource, trigger: 'manual', userId, action: 'Envio no Slack', ok, message, details });
    if (!getUserConnectors(userId).slack) log(false, 'Slack não conectado.');
    await withSlack(userId, res, async (token) => {
      let posted: { channel: string; ts: string };
      try {
        const channel = destination.startsWith('U')
          ? (await slackApi<{ channel: { id: string } }>(token, 'conversations.open', { users: destination })).channel.id
          : destination;
        posted = await slackApi<{ channel: string; ts: string }>(token, 'chat.postMessage', { channel, text, unfurl_links: 'false' });
      } catch (error) {
        log(false, error instanceof Error ? error.message : String(error));
        throw error;
      }
      log(true, 'Mensagem enviada no Slack.');
      let permalink: string | null = null;
      try {
        permalink = (await slackApi<{ permalink: string }>(token, 'chat.getPermalink', { channel: posted.channel, message_ts: posted.ts })).permalink;
      } catch {
        // só o link na UI
      }
      sendJson(res, 200, { ok: true, permalink });
    });
    return true;
  }

  return false;
}

// Outros tipos de coluna aparecem só leitura (`column_values.text`), com `editable: false`.
const EDITABLE_COLUMN_TYPES = ['text', 'long_text', 'numbers', 'status', 'dropdown', 'date', 'people', 'checkbox', 'link'] as const;
type EditableColumnType = (typeof EDITABLE_COLUMN_TYPES)[number];

interface NormalizedColumn {
  id: string;
  title: string;
  type: string;
  editable: boolean;
  options?: { id: string; label: string; color?: string }[];
}

interface RawColumn {
  id: string;
  title: string;
  type: string;
  settings_str: string;
}

const COLUMNS_FIELDS = 'columns { id title type settings_str }';

interface RawItem {
  id: string;
  name: string;
  column_values: { id: string; text: string | null; value: string | null }[];
}

function normalizeColumn(raw: RawColumn): NormalizedColumn {
  const editable = (EDITABLE_COLUMN_TYPES as readonly string[]).includes(raw.type);
  let options: { id: string; label: string; color?: string }[] | undefined;
  try {
    if (raw.type === 'status') {
      const settings = JSON.parse(raw.settings_str) as {
        labels?: Record<string, string>;
        labels_colors?: Record<string, { color?: string }>;
      };
      options = Object.entries(settings.labels ?? {}).map(([id, label]) => ({
        id,
        label,
        color: settings.labels_colors?.[id]?.color,
      }));
    } else if (raw.type === 'dropdown') {
      const settings = JSON.parse(raw.settings_str) as { labels?: { id: number; name: string }[] };
      options = (settings.labels ?? []).map((l) => ({ id: String(l.id), label: l.name }));
    }
  } catch {
    // settings_str malformado: segue sem opções
  }
  return { id: raw.id, title: raw.title, type: raw.type, editable, options };
}

/** Valor simples do formulário → formato que cada tipo de coluna espera em `column_values`. */
function serializeColumnValue(type: string, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;
  switch (type as EditableColumnType) {
    case 'text':
    case 'long_text':
    case 'numbers':
      return String(value);
    case 'status':
      return { label: String(value) };
    case 'dropdown':
      return { labels: (Array.isArray(value) ? value : [value]).map(String) };
    case 'date': {
      const v = value as { date: string; time?: string };
      return v.time ? { date: v.date, time: v.time } : { date: v.date };
    }
    case 'people': {
      const ids = Array.isArray(value) ? value : [value];
      return { personsAndTeams: ids.map((id) => ({ id: Number(id), kind: 'person' })) };
    }
    case 'checkbox':
      return value ? { checked: 'true' } : null;
    case 'link': {
      const v = value as { url: string; text?: string };
      return { url: v.url, text: v.text ?? '' };
    }
    default:
      return null;
  }
}

/** Inverso de `serializeColumnValue`. Status/dropdown só guardam índice/id: o rótulo vem de `column.options`. */
function parseColumnValue(column: NormalizedColumn, rawValueJson: string | null, text: string | null): unknown {
  if (rawValueJson == null) return column.type === 'checkbox' ? false : null;
  try {
    const parsed = JSON.parse(rawValueJson);
    switch (column.type as EditableColumnType) {
      case 'text':
      case 'long_text':
        return typeof parsed === 'string' ? parsed : (text ?? '');
      case 'numbers':
        return text ?? (parsed != null ? String(parsed) : '');
      case 'checkbox':
        return parsed?.checked === 'true' || parsed?.checked === true;
      case 'date':
        return parsed?.date ? { date: parsed.date, time: parsed.time || undefined } : null;
      case 'link':
        return parsed ? { url: parsed.url, text: parsed.text ?? '' } : null;
      case 'people':
        return Array.isArray(parsed?.personsAndTeams) ? parsed.personsAndTeams.map((p: { id: number }) => p.id) : [];
      case 'status': {
        const label = column.options?.find((o) => o.id === String(parsed?.index))?.label;
        return label ?? text ?? '';
      }
      case 'dropdown': {
        const ids: number[] = Array.isArray(parsed?.ids) ? parsed.ids : [];
        return ids.map((id) => column.options?.find((o) => o.id === String(id))?.label).filter((label): label is string => Boolean(label));
      }
      default:
        return text;
    }
  } catch {
    return text;
  }
}

function mapItem(item: RawItem, columns: NormalizedColumn[]) {
  return {
    id: item.id,
    name: item.name,
    columnValues: item.column_values.map((cv) => {
      const column = columns.find((c) => c.id === cv.id);
      return { columnId: cv.id, text: cv.text, value: column ? parseColumnValue(column, cv.value, cv.text) : cv.text };
    }),
  };
}

function buildColumnValuesObject(columns: NormalizedColumn[], columnValues: Record<string, unknown> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!columnValues) return result;
  for (const [columnId, rawValue] of Object.entries(columnValues)) {
    const column = columns.find((c) => c.id === columnId);
    if (!column?.editable) continue;
    result[columnId] = serializeColumnValue(column.type, rawValue);
  }
  return result;
}

async function fetchBoardDetail(
  token: string,
  boardId: string,
): Promise<{ columns: NormalizedColumn[]; groups: { id: string; title: string; color?: string }[] }> {
  const data = await mondayGraphQL<{ boards: { columns: RawColumn[]; groups: { id: string; title: string; color?: string }[] }[] }>(
    token,
    `query ($boardId: ID!) { boards (ids: [$boardId]) { ${COLUMNS_FIELDS} groups { id title color } } }`,
    { boardId },
  );
  const board = data.boards[0];
  return { columns: (board?.columns ?? []).map(normalizeColumn), groups: board?.groups ?? [] };
}

/** Chamador já garantiu `requireAuth`. */
export async function handleConnectorsRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith('/api/connectors/') && pathname !== '/api/connectors') return false;

  const userId = getAuthenticatedUserId(req)!;

  if (req.method === 'GET' && pathname === '/api/connectors/status') {
    const connectors = getUserConnectors(userId);
    return sendJson(res, 200, {
      monday: Boolean(connectors.monday),
      promoMonitor: Boolean(connectors.promoMonitor),
      promoMonitorEmail: connectors.promoMonitor?.email,
      promoMonitorHasTotpSecret: Boolean(connectors.promoMonitor?.totpSecret),
      slack: Boolean(connectors.slack),
      slackTeamName: connectors.slack?.teamName,
    });
  }

  if (pathname.startsWith('/api/connectors/slack/') && (await handleSlackRoute(req, res, pathname, userId))) return true;

  if (req.method === 'POST' && pathname === '/api/connectors/promo-monitor') {
    const body = (await readJsonBody(req)) as { email?: string; password?: string; totpSecret?: string };
    const email = String(body.email ?? '').trim();
    const password = String(body.password ?? '');
    const totpSecret = String(body.totpSecret ?? '').replace(/\s/g, '').toUpperCase();
    if (!email || !password) {
      return sendJson(res, 400, { error: 'Usuário e senha são obrigatórios.' });
    }
    if (totpSecret) {
      try {
        generateTotpCode(totpSecret);
      } catch {
        return sendJson(res, 400, { error: 'Chave do autenticador inválida (esperado base32: letras A-Z e dígitos 2-7).' });
      }
    }
    const panelTotpSecrets = getUserConnectors(userId).promoMonitor?.panelTotpSecrets;
    updateUserConnectors(userId, {
      promoMonitor: {
        email,
        password,
        ...(totpSecret ? { totpSecret } : {}),
        ...(panelTotpSecrets ? { panelTotpSecrets } : {}),
        connectedAt: new Date().toISOString(),
      },
    });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/connectors/promo-monitor/disconnect') {
    updateUserConnectors(userId, { promoMonitor: undefined });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/connectors/monday/authorize') {
    const clientId = rootEnv('MONDAY_CLIENT_ID');
    if (!clientId) {
      return sendJson(res, 400, { error: 'MONDAY_CLIENT_ID não configurado no .env raiz.' });
    }
    const state = createPendingState(userId, appOrigin(req));
    const authorizeUrl = new URL('https://auth.monday.com/oauth2/authorize');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', mondayRedirectUri(req));
    authorizeUrl.searchParams.set('scope', MONDAY_SCOPES);
    authorizeUrl.searchParams.set('state', state);
    // Sem isso, conta que nunca instalou o app recebe "App is unavailable".
    authorizeUrl.searchParams.set('force_install_if_needed', 'true');
    res.statusCode = 302;
    res.setHeader('Location', authorizeUrl.toString());
    res.end();
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/connectors/monday/callback') {
    const code = url.searchParams.get('code');
    const pending = consumePendingState(url.searchParams.get('state'));
    if (!pending || !code) {
      sendPopupCloseHtml(res, { ok: false, error: 'Autorização inválida ou expirada.' });
      return true;
    }
    const clientId = rootEnv('MONDAY_CLIENT_ID');
    const clientSecret = rootEnv('MONDAY_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      sendPopupCloseHtml(res, { ok: false, error: 'MONDAY_CLIENT_ID/MONDAY_CLIENT_SECRET não configurados no .env raiz.' });
      return true;
    }
    try {
      const { res: tokenRes, json: tokenJson } = await fetchJson('Monday', 'https://auth.monday.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, redirect_uri: mondayRedirectUri(req), code }),
      });
      if (!tokenRes.ok || !tokenJson.access_token) {
        sendPopupCloseHtml(res, { ok: false, error: tokenJson.error_description ?? 'Monday recusou a troca do código por token.' });
        return true;
      }
      const accessToken = tokenJson.access_token as string;
      let accountName: string | undefined;
      try {
        const me = await mondayGraphQL<{ me: { name: string; account: { name: string } } }>(accessToken, 'query { me { name account { name } } }');
        accountName = me.me.account?.name ?? me.me.name;
      } catch {
        // só rótulo na UI
      }
      updateUserConnectors(pending.userId, { monday: { accessToken, accountName, connectedAt: new Date().toISOString() } });
      sendPopupCloseHtml(res, { ok: true });
    } catch (error) {
      sendPopupCloseHtml(res, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/connectors/monday/disconnect') {
    updateUserConnectors(userId, { monday: undefined });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/connectors/monday/boards') {
    await withMonday(userId, res, async (token) => {
      const data = await mondayGraphQL<{ boards: { id: string; name: string; state: string; workspace: { id: string; name: string } | null }[] }>(
        token,
        'query { boards (limit: 200) { id name state workspace { id name } } }',
      );
      const workspaces = new Map<string, { workspace: { id: string; name: string }; boards: { id: string; name: string }[] }>();
      for (const board of data.boards) {
        if (board.state !== 'active') continue;
        const workspace = board.workspace ?? { id: '_none', name: 'Sem workspace' };
        if (isHiddenMondayName(workspace.name) || isHiddenMondayName(board.name)) continue;
        if (!workspaces.has(workspace.id)) workspaces.set(workspace.id, { workspace, boards: [] });
        workspaces.get(workspace.id)!.boards.push({ id: board.id, name: board.name });
      }
      sendJson(res, 200, Array.from(workspaces.values()));
    });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/connectors/monday/users') {
    await withMonday(userId, res, async (token) => {
      const data = await mondayGraphQL<{ users: { id: string; name: string; photo_thumb_small: string | null }[] }>(
        token,
        'query { users (limit: 200) { id name photo_thumb_small } }',
      );
      sendJson(res, 200, data.users);
    });
    return true;
  }

  const boardDetailMatch = pathname.match(/^\/api\/connectors\/monday\/boards\/([^/]+)$/);
  if (req.method === 'GET' && boardDetailMatch) {
    const boardId = boardDetailMatch[1]!;
    await withMonday(userId, res, async (token) => {
      sendJson(res, 200, await fetchBoardDetail(token, boardId));
    });
    return true;
  }

  const groupsMatch = pathname.match(/^\/api\/connectors\/monday\/boards\/([^/]+)\/groups$/);
  if (req.method === 'POST' && groupsMatch) {
    const boardId = groupsMatch[1]!;
    const body = await readJsonBody(req);
    const groupName = String(body.name ?? '').trim();
    if (!groupName) {
      return sendJson(res, 400, { error: 'Nome do grupo é obrigatório.' });
    }
    await withMonday(userId, res, async (token) => {
      const data = await mondayGraphQL<{ create_group: { id: string; title: string } }>(
        token,
        'mutation ($boardId: ID!, $groupName: String!) { create_group (board_id: $boardId, group_name: $groupName) { id title } }',
        { boardId, groupName },
      );
      sendJson(res, 200, data.create_group);
    });
    return true;
  }

  const itemsMatch = pathname.match(/^\/api\/connectors\/monday\/boards\/([^/]+)\/items$/);
  if (req.method === 'GET' && itemsMatch) {
    const boardId = itemsMatch[1]!;
    const groupId = url.searchParams.get('groupId');
    const cursor = url.searchParams.get('cursor');
    if (!groupId) {
      return sendJson(res, 400, { error: 'groupId é obrigatório.' });
    }
    await withMonday(userId, res, async (token) => {
      const data = await mondayGraphQL<{
        boards: {
          columns: RawColumn[];
          groups: { items_page: { cursor: string | null; items: RawItem[] } }[];
        }[];
      }>(
        token,
        `query ($boardId: ID!, $groupId: [String], $cursor: String) { boards (ids: [$boardId]) { ${COLUMNS_FIELDS} groups (ids: $groupId) { items_page (limit: 25, cursor: $cursor) { cursor items { id name column_values { id text value } } } } } }`,
        { boardId, groupId: [groupId], cursor: cursor || null },
      );
      const board = data.boards[0];
      const columns = (board?.columns ?? []).map(normalizeColumn);
      const page = board?.groups[0]?.items_page;
      sendJson(res, 200, {
        cursor: page?.cursor ?? null,
        items: (page?.items ?? []).map((item) => mapItem(item, columns)),
      });
    });
    return true;
  }

  if (req.method === 'POST' && itemsMatch) {
    const boardId = itemsMatch[1]!;
    const body = await readJsonBody(req);
    const name = String(body.name ?? '').trim();
    if (!name) {
      return sendJson(res, 400, { error: 'Nome do item é obrigatório.' });
    }
    const groupId = body.groupId ? String(body.groupId) : undefined;
    const columnValues = (body.columnValues ?? undefined) as Record<string, unknown> | undefined;
    await withMonday(userId, res, async (token) => {
      const columnValuesObj = columnValues ? buildColumnValuesObject((await fetchBoardDetail(token, boardId)).columns, columnValues) : {};
      const created = await mondayGraphQL<{ create_item: { id: string; name: string } }>(
        token,
        'mutation ($boardId: ID!, $itemName: String!, $groupId: String, $columnValues: JSON) { create_item (board_id: $boardId, item_name: $itemName, group_id: $groupId, column_values: $columnValues) { id name } }',
        { boardId, itemName: name, groupId: groupId ?? null, columnValues: Object.keys(columnValuesObj).length > 0 ? JSON.stringify(columnValuesObj) : null },
      );
      const updateText = String(body.updateText ?? '').trim();
      let updateWarning: string | undefined;
      if (updateText) {
        // Item já criado: responder erro faria o cliente repetir e duplicar o item.
        try {
          await mondayGraphQL(token, 'mutation ($itemId: ID!, $body: String!) { create_update (item_id: $itemId, body: $body) { id } }', {
            itemId: created.create_item.id,
            body: updateText,
          });
        } catch (error) {
          updateWarning = `Item criado, mas o comentário não foi salvo: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      sendJson(res, 200, { ...created.create_item, ...(updateWarning ? { updateWarning } : {}) });
    });
    return true;
  }

  const itemMatch = pathname.match(/^\/api\/connectors\/monday\/items\/([^/]+)$/);
  if (req.method === 'GET' && itemMatch) {
    const itemId = itemMatch[1]!;
    const boardId = url.searchParams.get('boardId');
    if (!boardId) {
      return sendJson(res, 400, { error: 'boardId é obrigatório.' });
    }
    await withMonday(userId, res, async (token) => {
      const data = await mondayGraphQL<{
        items: RawItem[];
        boards: { columns: RawColumn[] }[];
      }>(
        token,
        `query ($itemId: ID!, $boardId: ID!) { items (ids: [$itemId]) { id name column_values { id text value } } boards (ids: [$boardId]) { ${COLUMNS_FIELDS} } }`,
        { itemId, boardId },
      );
      const item = data.items[0];
      if (!item) {
        sendJson(res, 404, { error: 'Item não encontrado.' });
        return;
      }
      const columns = (data.boards[0]?.columns ?? []).map(normalizeColumn);
      sendJson(res, 200, mapItem(item, columns));
    });
    return true;
  }

  if (req.method === 'PATCH' && itemMatch) {
    const itemId = itemMatch[1]!;
    const body = await readJsonBody(req);
    const boardId = String(body.boardId ?? '');
    if (!boardId) {
      return sendJson(res, 400, { error: 'boardId é obrigatório pra editar um item.' });
    }
    const name = body.name !== undefined ? String(body.name).trim() : undefined;
    const columnValues = (body.columnValues ?? undefined) as Record<string, unknown> | undefined;
    await withMonday(userId, res, async (token) => {
      const { columns } = await fetchBoardDetail(token, boardId);
      const columnValuesObj = buildColumnValuesObject(columns, columnValues);
      if (name) columnValuesObj.name = name;
      const updated = await mondayGraphQL<{ change_multiple_column_values: { id: string; name: string } }>(
        token,
        'mutation ($itemId: ID!, $boardId: ID!, $columnValues: JSON!) { change_multiple_column_values (item_id: $itemId, board_id: $boardId, column_values: $columnValues) { id name } }',
        { itemId, boardId, columnValues: JSON.stringify(columnValuesObj) },
      );
      sendJson(res, 200, updated.change_multiple_column_values);
    });
    return true;
  }

  if (req.method === 'DELETE' && itemMatch) {
    const itemId = itemMatch[1]!;
    await withMonday(userId, res, async (token) => {
      await mondayGraphQL(token, 'mutation ($itemId: ID!) { delete_item (item_id: $itemId) { id } }', { itemId });
      sendJson(res, 200, { ok: true });
    });
    return true;
  }

  const itemUpdatesMatch = pathname.match(/^\/api\/connectors\/monday\/items\/([^/]+)\/updates$/);
  if (req.method === 'GET' && itemUpdatesMatch) {
    const itemId = itemUpdatesMatch[1]!;
    await withMonday(userId, res, async (token) => {
      const data = await mondayGraphQL<{ items: { updates: { id: string; text_body: string; created_at: string; creator: { name: string } | null }[] }[] }>(
        token,
        'query ($itemId: ID!) { items (ids: [$itemId]) { updates { id text_body created_at creator { name } } } }',
        { itemId },
      );
      sendJson(res, 200, data.items[0]?.updates ?? []);
    });
    return true;
  }

  if (req.method === 'POST' && itemUpdatesMatch) {
    const itemId = itemUpdatesMatch[1]!;
    const body = await readJsonBody(req);
    const text = String(body.body ?? '').trim();
    if (!text) {
      return sendJson(res, 400, { error: 'Texto do comentário é obrigatório.' });
    }
    await withMonday(userId, res, async (token) => {
      const data = await mondayGraphQL<{ create_update: { id: string } }>(
        token,
        'mutation ($itemId: ID!, $body: String!) { create_update (item_id: $itemId, body: $body) { id } }',
        { itemId, body: text },
      );
      sendJson(res, 200, data.create_update);
    });
    return true;
  }

  const checklistUpdateMatch = pathname.match(/^\/api\/connectors\/monday\/items\/([^/]+)\/checklist-update$/);
  if (req.method === 'POST' && checklistUpdateMatch) {
    const itemId = checklistUpdateMatch[1]!;
    const body = await readJsonBody(req);
    const title = String(body.title ?? '').trim();
    const tasks = (Array.isArray(body.tasks) ? body.tasks : []).map((task) => String(task).trim()).filter(Boolean);
    const userIds = (Array.isArray(body.userIds) ? body.userIds : []).map(String).filter((id) => /^\d+$/.test(id));
    if (!tasks.length || tasks.length > 200) {
      return sendJson(res, 400, { error: 'Envie de 1 a 200 itens pra lista de verificação.' });
    }
    // Checklist em atualização não é oficial na API: é o HTML que o editor do Monday reconhece.
    const html = [
      title ? `<p><strong>${escapeHtml(title)}</strong></p>` : '',
      `<ul class="checklist">${tasks.map((task) => `<li class="checklist_task">${escapeHtml(task)}</li>`).join('')}</ul>`,
    ].join('');
    const boardId = String(body.boardId ?? '');
    const assignColumnId = userIds.length ? String(body.assignColumnId ?? '') : '';
    if (assignColumnId && !boardId) {
      return sendJson(res, 400, { error: 'Quadro é obrigatório pra atribuir.' });
    }
    await withMonday(userId, res, async (token) => {
      // Atribui antes de criar a atualização: se falhar, nada foi criado e repetir não duplica.
      if (assignColumnId) {
        const current = await mondayGraphQL<{ items: { column_values: { value: string | null }[] }[] }>(
          token,
          'query ($itemId: ID!, $columnId: String!) { items (ids: [$itemId]) { column_values (ids: [$columnId]) { value } } }',
          { itemId, columnId: assignColumnId },
        );
        const rawValue = current.items[0]?.column_values[0]?.value;
        const people: { id: number; kind: string }[] = rawValue ? (JSON.parse(rawValue).personsAndTeams ?? []) : [];
        for (const id of userIds) {
          if (!people.some((person) => person.kind === 'person' && String(person.id) === id)) people.push({ id: Number(id), kind: 'person' });
        }
        await mondayGraphQL(
          token,
          'mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) { change_column_value (board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id } }',
          { boardId, itemId, columnId: assignColumnId, value: JSON.stringify({ personsAndTeams: people }) },
        );
      }
      const created = await mondayGraphQL<{ create_update: { id: string } }>(
        token,
        'mutation ($itemId: ID!, $body: String!, $mentions: [UpdateMention]) { create_update (item_id: $itemId, body: $body, mentions_list: $mentions) { id } }',
        { itemId, body: html, mentions: assignColumnId ? [] : userIds.map((id) => ({ id, type: 'User' })) },
        '2025-07',
      );
      const data = await mondayGraphQL<{ items: { url: string }[] }>(token, 'query ($itemId: ID!) { items (ids: [$itemId]) { url } }', { itemId });
      const itemUrl = data.items[0]?.url;
      sendJson(res, 200, { id: created.create_update.id, url: itemUrl ? `${itemUrl}/posts/${created.create_update.id}` : null });
    });
    return true;
  }

  const itemSubitemsMatch = pathname.match(/^\/api\/connectors\/monday\/items\/([^/]+)\/subitems$/);
  if (req.method === 'GET' && itemSubitemsMatch) {
    const itemId = itemSubitemsMatch[1]!;
    await withMonday(userId, res, async (token) => {
      // Subitem vive num board próprio de subitens: é o `board.id` dele que serve pra editar/excluir.
      const data = await mondayGraphQL<{ items: { subitems: { id: string; name: string; board: { id: string } | null }[] }[] }>(
        token,
        'query ($itemId: ID!) { items (ids: [$itemId]) { subitems { id name board { id } } } }',
        { itemId },
      );
      const subitems = data.items[0]?.subitems ?? [];
      sendJson(res, 200, subitems.map((s) => ({ id: s.id, name: s.name, boardId: s.board?.id ?? '' })));
    });
    return true;
  }

  if (req.method === 'POST' && itemSubitemsMatch) {
    const itemId = itemSubitemsMatch[1]!;
    const body = await readJsonBody(req);
    const name = String(body.name ?? '').trim();
    if (!name) {
      return sendJson(res, 400, { error: 'Nome do subitem é obrigatório.' });
    }
    await withMonday(userId, res, async (token) => {
      await mondayGraphQL(
        token,
        'mutation ($itemId: ID!, $itemName: String!) { create_subitem (parent_item_id: $itemId, item_name: $itemName) { id name } }',
        { itemId, itemName: name },
      );
      sendJson(res, 200, { ok: true });
    });
    return true;
  }

  return sendJson(res, 404, { error: 'Rota de conectores desconhecida.' });
}
