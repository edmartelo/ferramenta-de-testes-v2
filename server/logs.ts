import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RowDataPacket } from 'mysql2/promise';
import { db, jsonValue } from '../src/lib/db.ts';
import { sendJson } from './http-utils.ts';

export const LOG_SOURCES = ['recorrencias'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];
export const LOG_TRIGGERS = ['agendada', 'manual'] as const;
export type LogTrigger = (typeof LOG_TRIGGERS)[number];
export type LogDetails = Record<string, number | string | boolean>;

export interface LogEntry {
  source: LogSource;
  trigger: LogTrigger;
  /** Na agendada, quem ligou o agendamento nesta máquina. */
  userId?: string;
  action: string;
  ok: boolean;
  message: string;
  details?: LogDetails;
}

export interface StoredLog extends Omit<LogEntry, 'userId'> {
  id: number;
  createdAt: number;
  userId: string | null;
  userName: string | null;
}

export interface LogFilters {
  before?: number;
  id?: number;
  /** Epoch ms, inclusivo. */
  from?: number;
  /** Epoch ms, exclusivo. */
  to?: number;
  trigger?: LogTrigger;
  userId?: string;
  onlyErrors?: boolean;
}

export interface LogUser {
  id: string;
  name: string | null;
}

/** Ex.: "1 min 05 s". */
export function durationDetail(startedAt: number): string {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/** Só nomes de promoção e contagens: nada de participante. */
export function promotionsScanDetails(promotions: { name: string; ok: boolean; failingLines: string[] }[]): LogDetails {
  const failed = promotions.filter((promotion) => !promotion.ok);
  const divergent = promotions.filter((promotion) => promotion.failingLines.length > 0);
  return {
    promocoes: promotions.length,
    promocoesComFalha: failed.length,
    ...(failed.length > 0 && { falharam: failed.map((promotion) => promotion.name).join(', ') }),
    ...(divergent.length > 0 && { comDivergencia: divergent.map((promotion) => `${promotion.name} (${promotion.failingLines.length})`).join(', ') }),
  };
}

const RETENTION_MS = 90 * 24 * 60 * 60_000;
const PAGE_SIZE = 50;

async function insertLog(entry: LogEntry): Promise<void> {
  const pool = await db();
  const now = Date.now();
  await pool.query(
    'INSERT INTO logs (source, created_at, user_id, trigger_type, action, ok, message, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [entry.source, now, entry.userId ?? null, entry.trigger, entry.action.slice(0, 255), entry.ok, entry.message.slice(0, 1000), entry.details ? JSON.stringify(entry.details) : null],
  );
  await pool.query('DELETE FROM logs WHERE created_at < ?', [now - RETENTION_MS]);
}

/** Falha ao gravar o log nunca derruba quem chamou. */
export function recordLog(entry: LogEntry, onError: (message: string) => void = console.error): void {
  void insertLog(entry).catch((error: Error) => onError(`Log não gravado (${entry.action}): ${error.message}`));
}

async function listLogs(source: LogSource, filters: LogFilters): Promise<{ logs: StoredLog[]; hasMore: boolean }> {
  const conditions = ['l.source = ?'];
  const params: unknown[] = [source];
  const add = (condition: string, value: unknown) => {
    conditions.push(condition);
    params.push(value);
  };
  if (filters.before) add('l.id < ?', filters.before);
  if (filters.id) add('l.id = ?', filters.id);
  if (filters.from) add('l.created_at >= ?', filters.from);
  if (filters.to) add('l.created_at < ?', filters.to);
  if (filters.trigger) add('l.trigger_type = ?', filters.trigger);
  if (filters.userId) add('l.user_id = ?', filters.userId);
  if (filters.onlyErrors) conditions.push('l.ok = FALSE');
  const [rows] = await (await db()).query<RowDataPacket[]>(
    `SELECT l.id, l.source, l.created_at AS createdAt, l.user_id AS userId, u.name AS userName, l.trigger_type AS \`trigger\`,
            l.action, l.ok, l.message, l.details
       FROM logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY l.id DESC LIMIT ?`,
    [...params, PAGE_SIZE + 1],
  );
  const logs = rows.slice(0, PAGE_SIZE).map((row) => ({
    ...row,
    id: Number(row.id),
    createdAt: Number(row.createdAt),
    ok: Boolean(row.ok),
    details: row.details === null ? undefined : jsonValue<LogDetails>(row.details),
  })) as StoredLog[];
  return { logs, hasMore: rows.length > PAGE_SIZE };
}

async function listLogUsers(source: LogSource): Promise<LogUser[]> {
  const [rows] = await (await db()).query<RowDataPacket[]>(
    `SELECT DISTINCT l.user_id AS id, u.name FROM logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.source = ? AND l.user_id IS NOT NULL ORDER BY u.name`,
    [source],
  );
  return rows as LogUser[];
}

function positiveInt(value: string | null): number | undefined {
  const number = Number(value);
  return value && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** Chamador já garantiu `requireAuth`. */
export async function handleLogsRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if ((url.pathname !== '/api/logs' && url.pathname !== '/api/logs/users') || req.method !== 'GET') return false;
  const params = url.searchParams;
  const source = params.get('source') as LogSource;
  if (!LOG_SOURCES.includes(source)) return sendJson(res, 400, { error: 'Origem de log inválida.' });
  if (url.pathname === '/api/logs/users') return sendJson(res, 200, await listLogUsers(source));
  const trigger = params.get('trigger') as LogTrigger;
  return sendJson(
    res,
    200,
    await listLogs(source, {
      before: positiveInt(params.get('before')),
      id: positiveInt(params.get('id')),
      from: positiveInt(params.get('from')),
      to: positiveInt(params.get('to')),
      trigger: LOG_TRIGGERS.includes(trigger) ? trigger : undefined,
      userId: params.get('userId')?.slice(0, 32) || undefined,
      onlyErrors: params.get('onlyErrors') === '1',
    }),
  );
}
