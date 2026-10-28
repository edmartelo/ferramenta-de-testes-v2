import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { db, jsonValue } from '../src/lib/db.ts';
import type { TestRunEvent } from './test-runner.ts';

type TestEndEvent = Extract<TestRunEvent, { type: 'test-end' }>;

interface TestResultRow {
  itemId: string;
  title: string;
  status: TestEndEvent['status'];
  detail?: string;
}

const MANUAL_CHECK_STATES = ['done', 'queued', 'sent'] as const;
export type ManualCheckState = (typeof MANUAL_CHECK_STATES)[number];
export type ManualChecks = Record<string, ManualCheckState>;

export function isManualChecks(value: unknown): value is ManualChecks {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every((state) => (MANUAL_CHECK_STATES as readonly unknown[]).includes(state));
}

export interface StoredTestRun {
  runGroup: string;
  total: number;
  results: TestResultRow[];
  manualChecks: ManualChecks;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export async function readLastTestRun(promotionId: string, env: string): Promise<StoredTestRun | null> {
  const [rows] = await (await db()).query<RowDataPacket[]>(
    `SELECT run_group AS runGroup, total, results, manual_checks AS manualChecks, error, started_at AS startedAt, finished_at AS finishedAt
     FROM test_runs WHERE promotion_id = ? AND env = ?`,
    [promotionId, env],
  );
  const row = rows[0];
  if (!row) return null;
  // Rodadas antigas guardam só a lista de concluídos.
  const storedChecks = jsonValue<ManualChecks | string[]>(row.manualChecks);
  const manualChecks = Array.isArray(storedChecks)
    ? Object.fromEntries(storedChecks.map((itemId) => [itemId, 'done']))
    : storedChecks;
  return { ...row, results: jsonValue<TestResultRow[]>(row.results), manualChecks, startedAt: Number(row.startedAt), finishedAt: row.finishedAt === null ? null : Number(row.finishedAt) } as StoredTestRun;
}

export async function deleteTestRuns(promotionId: string): Promise<void> {
  await (await db()).query('DELETE FROM test_runs WHERE promotion_id = ?', [promotionId]);
}

export async function saveManualChecks(promotionId: string, env: string, checks: ManualChecks): Promise<boolean> {
  const [result] = await (await db()).query<ResultSetHeader>(
    'UPDATE test_runs SET manual_checks = ? WHERE promotion_id = ? AND env = ?',
    [JSON.stringify(checks), promotionId, env],
  );
  return result.affectedRows > 0;
}

/** Substitui a última rodada de promoção+ambiente no primeiro evento, com escritas em fila pra manter a ordem. */
export function createTestRunRecorder(promotionId: string, env: string, runGroup: string): (event: TestRunEvent) => void {
  const results: TestResultRow[] = [];
  let queue: Promise<unknown> | undefined;

  function enqueue(sql: string, params: unknown[]): void {
    queue = (queue ?? Promise.resolve())
      .then(() => db())
      .then((pool) => pool.query(sql, params))
      .catch((error: Error) => console.error(`[test-runs] falha ao gravar rodada de ${promotionId}:${env}: ${error.message}`));
  }

  return (event) => {
    if (!queue) {
      enqueue(
        `REPLACE INTO test_runs (promotion_id, env, run_group, total, results, manual_checks, error, started_at, finished_at)
         VALUES (?, ?, ?, 0, '[]', '{}', NULL, ?, NULL)`,
        [promotionId, env, runGroup, Date.now()],
      );
    }
    if (event.type === 'begin') {
      enqueue('UPDATE test_runs SET total = ? WHERE promotion_id = ? AND env = ?', [event.total, promotionId, env]);
    } else if (event.type === 'test-end') {
      results.push({ itemId: event.id, title: event.title, status: event.status, detail: event.detail });
      enqueue('UPDATE test_runs SET results = ? WHERE promotion_id = ? AND env = ?', [JSON.stringify(results), promotionId, env]);
    } else if (event.type === 'end') {
      enqueue('UPDATE test_runs SET error = ?, finished_at = ? WHERE promotion_id = ? AND env = ?', [
        event.success ? null : (event.error ?? 'Falha na execução.'),
        Date.now(),
        promotionId,
        env,
      ]);
    }
  };
}
