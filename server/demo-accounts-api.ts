import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { db } from '../src/lib/db.ts';
import { getAuthenticatedRole } from './auth.ts';
import { readJsonBody, sendJson } from './http-utils.ts';
import { DEMO_ACCOUNT_EVENTS, DEMO_DATABASE, type DemoAccountEvent } from './demo/schema.ts';

export interface DemoAccount {
  id: string;
  name: string;
  email: string;
  company: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  loginCount: number;
  disabled: boolean;
}

export interface DemoAccountEventLog {
  id: number;
  accountId: string;
  event: DemoAccountEvent;
  name: string;
  email: string;
  company: string | null;
  /** Tela visitada ou ação feita; vazio nos eventos de conta. */
  detail: string | null;
  createdAt: number;
}

export interface DemoAccountEventFilters {
  before?: number;
  id?: number;
  /** Epoch ms, inclusivo. */
  from?: number;
  /** Epoch ms, exclusivo. */
  to?: number;
  event?: DemoAccountEvent;
  /** Trecho de nome, e-mail, empresa ou detalhe. */
  search?: string;
}

const EVENTS_PAGE_SIZE = 50;

/** Banco da demo ainda não criado (`npm run demo:setup`): a tela mostra o aviso em vez de quebrar. */
const NOT_CONFIGURED = 'Banco da demo não encontrado. Rode `npm run demo:setup`.';

async function listDemoAccounts(from: number | undefined, to: number | undefined): Promise<DemoAccount[]> {
  const [rows] = await (await db()).query<RowDataPacket[]>(
    // Epoch nos dois sentidos: o servidor MySQL roda em UTC e o driver converteria TIMESTAMP pelo fuso local.
    `SELECT id, name, email, company, UNIX_TIMESTAMP(created_at) * 1000 AS createdAt, UNIX_TIMESTAMP(last_login_at) * 1000 AS lastLoginAt,
       login_count AS loginCount, disabled
     FROM ${DEMO_DATABASE}.demo_accounts
     WHERE created_at >= FROM_UNIXTIME(?) AND created_at < FROM_UNIXTIME(?)
     ORDER BY created_at DESC LIMIT 1000`,
    [(from ?? 0) / 1000, (to ?? Date.now() + 60_000) / 1000],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    createdAt: Number(row.createdAt),
    lastLoginAt: row.lastLoginAt === null ? null : Number(row.lastLoginAt),
    loginCount: Number(row.loginCount),
    disabled: Boolean(row.disabled),
  }));
}

async function listDemoAccountEvents(filters: DemoAccountEventFilters): Promise<{ events: DemoAccountEventLog[]; hasMore: boolean }> {
  const conditions = ['TRUE'];
  const params: unknown[] = [];
  const add = (condition: string, ...values: unknown[]) => {
    conditions.push(condition);
    params.push(...values);
  };
  if (filters.before) add('id < ?', filters.before);
  if (filters.id) add('id = ?', filters.id);
  if (filters.from !== undefined) add('created_at >= FROM_UNIXTIME(?)', filters.from / 1000);
  if (filters.to !== undefined) add('created_at < FROM_UNIXTIME(?)', filters.to / 1000);
  if (filters.event) add('event = ?', filters.event);
  if (filters.search) {
    const like = `%${filters.search.replace(/[\\%_]/g, '\\$&')}%`;
    add('(name LIKE ? OR email LIKE ? OR company LIKE ? OR detail LIKE ?)', like, like, like, like);
  }
  const [rows] = await (await db()).query<RowDataPacket[]>(
    `SELECT id, account_id AS accountId, event, name, email, company, detail, UNIX_TIMESTAMP(created_at) * 1000 AS createdAt
     FROM ${DEMO_DATABASE}.demo_account_events
     WHERE ${conditions.join(' AND ')}
     ORDER BY id DESC LIMIT ?`,
    [...params, EVENTS_PAGE_SIZE + 1],
  );
  const events = rows.slice(0, EVENTS_PAGE_SIZE).map((row) => ({ ...row, id: Number(row.id), createdAt: Number(row.createdAt) })) as DemoAccountEventLog[];
  return { events, hasMore: rows.length > EVENTS_PAGE_SIZE };
}

function epoch(value: string | null): number | undefined {
  const number = Number(value);
  return value && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

/** Chamador já garantiu `requireAuth`. Só Master vê quem se cadastrou na demo. */
export async function handleDemoAccountsRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = /^\/api\/demo-accounts(?:\/([0-9a-f]{32}|events))?$/.exec(url.pathname);
  if (!match) return false;
  if (getAuthenticatedRole(req) !== 'master') return sendJson(res, 403, { error: 'Só usuários Master veem as contas da demo.' });
  try {
    if (match[1] === 'events') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Método não permitido.' });
      const params = url.searchParams;
      const event = params.get('event') as DemoAccountEvent;
      return sendJson(
        res,
        200,
        await listDemoAccountEvents({
          before: epoch(params.get('before')) || undefined,
          id: epoch(params.get('id')) || undefined,
          from: epoch(params.get('from')),
          to: epoch(params.get('to')),
          event: DEMO_ACCOUNT_EVENTS.includes(event) ? event : undefined,
          search: params.get('search')?.trim().slice(0, 100) || undefined,
        }),
      );
    }
    if (req.method === 'GET' && !match[1]) {
      return sendJson(res, 200, await listDemoAccounts(epoch(url.searchParams.get('from')), epoch(url.searchParams.get('to'))));
    }
    if (req.method === 'PATCH' && match[1]) {
      const { disabled } = await readJsonBody(req);
      if (typeof disabled !== 'boolean') return sendJson(res, 400, { error: 'Informe "disabled".' });
      const [result] = await (await db()).query<ResultSetHeader>(`UPDATE ${DEMO_DATABASE}.demo_accounts SET disabled = ? WHERE id = ?`, [disabled, match[1]]);
      return sendJson(res, result.affectedRows ? 200 : 404, result.affectedRows ? { ok: true } : { error: 'Conta não encontrada.' });
    }
    if (req.method === 'DELETE' && match[1]) {
      const pool = await db();
      const [result] = await pool.query<ResultSetHeader>(`DELETE FROM ${DEMO_DATABASE}.demo_accounts WHERE id = ?`, [match[1]]);
      if (!result.affectedRows) return sendJson(res, 404, { error: 'Conta não encontrada.' });
      // Excluir apaga também o histórico da conta; fica só o registro anônimo de que houve exclusão.
      await pool.query(`DELETE FROM ${DEMO_DATABASE}.demo_account_events WHERE account_id = ?`, [match[1]]);
      await pool.query(
        `INSERT INTO ${DEMO_DATABASE}.demo_account_events (account_id, event, name, email, company) VALUES (?, 'exclusao-master', 'Conta excluída', '', NULL)`,
        [match[1]],
      );
      return sendJson(res, 200, { ok: true });
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ER_BAD_DB_ERROR' || code === 'ER_NO_SUCH_TABLE') return sendJson(res, 503, { error: NOT_CONFIGURED });
    throw error;
  }
  return sendJson(res, 405, { error: 'Método não permitido.' });
}
