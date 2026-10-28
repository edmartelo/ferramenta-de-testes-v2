import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { db, jsonValue } from '../src/lib/db.ts';
import { PROMOTIONS_ROOT } from '../src/lib/paths.ts';
import { readPromotionPaths, writePromotionPaths } from '../src/lib/promotion-local-paths.ts';
import type { EnvKey, PromotionConfig } from './types.ts';

export type { EnvKey, PromotionConfig } from './types.ts';

/** As pastas vêm só do `.local-paths.json` desta máquina: `paths` no banco seria de outra, e o dev-bootstrap descarta alterações nelas. */
function withLocalPaths(data: unknown): PromotionConfig {
  const promotion = jsonValue<PromotionConfig>(data);
  return { ...promotion, paths: readPromotionPaths(promotion.id) ?? { backend: '', frontend: '' } };
}

export async function readPromotion(id: string): Promise<PromotionConfig | undefined> {
  const [rows] = await (await db()).query<RowDataPacket[]>('SELECT data FROM promotions WHERE id = ?', [id]);
  return rows[0] ? withLocalPaths(rows[0].data) : undefined;
}

/** Pasta recém-criada pode estar esperando o INSERT da própria promoção. */
const ARCHIVE_MIN_AGE_MS = 10 * 60_000;
const SECRET_FILE = /^(\.credentials\.json|\.painel-session-.+\.json)$/;

function removeSecretFiles(dir: string): void {
  for (const file of readdirSync(dir)) {
    if (SECRET_FILE.test(file)) rmSync(join(dir, file), { force: true });
  }
}

/**
 * Promoção excluída em outra máquina: a pasta daqui é arquivada, pra uma recriada com o mesmo slug não herdar nada,
 * sem credenciais nem sessão de painel. Roda no servidor, nunca numa leitura.
 */
export async function archiveDeletedPromotionFolders(): Promise<void> {
  if (!existsSync(PROMOTIONS_ROOT)) return;
  const [rows] = await (await db()).query<RowDataPacket[]>('SELECT id FROM promotions');
  // Banco vazio é mais provável problema do banco que todas excluídas: não arquiva nada.
  if (rows.length === 0) return;
  const ids = new Set(rows.map((row) => String(row.id)));
  const stamp = new Date().toISOString().slice(0, 10);
  for (const entry of readdirSync(PROMOTIONS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '_template') continue;
    const dir = join(PROMOTIONS_ROOT, entry.name);
    try {
      if (entry.name.startsWith('_')) {
        removeSecretFiles(dir);
        continue;
      }
      if (ids.has(entry.name) || Date.now() - statSync(dir).mtimeMs < ARCHIVE_MIN_AGE_MS) continue;
      removeSecretFiles(dir);
      renameSync(dir, join(PROMOTIONS_ROOT, `_excluida-${entry.name}-${stamp}`));
    } catch {
      // No Windows a pasta aberta por outro processo dá EPERM: tenta na próxima rodada, sem derrubar esta.
    }
  }
}

export async function listPromotions(): Promise<PromotionConfig[]> {
  const [rows] = await (await db()).query<RowDataPacket[]>('SELECT data FROM promotions ORDER BY id');
  return rows.map((row) => withLocalPaths(row.data));
}

export async function promotionExists(id: string): Promise<boolean> {
  const [rows] = await (await db()).query<RowDataPacket[]>('SELECT 1 FROM promotions WHERE id = ?', [id]);
  return rows.length > 0;
}

export class PromotionConflictError extends Error {
  constructor() {
    super('A promoção foi alterada por outra pessoa enquanto você salvava. Recarregue a página e tente de novo.');
  }
}

/** Com `version` (lida junto em `readPromotionForUpdate`), só grava se ninguém gravou depois; sem ela, cria ou substitui. */
export async function writePromotion(promotion: PromotionConfig, version?: number): Promise<void> {
  const { paths, ...shared } = promotion;
  const pool = await db();
  if (version === undefined) {
    await pool.query(
      'INSERT INTO promotions (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), version = version + 1',
      [promotion.id, JSON.stringify(shared)],
    );
  } else {
    const [result] = await pool.query<ResultSetHeader>(
      'UPDATE promotions SET data = ?, version = version + 1 WHERE id = ? AND version = ?',
      [JSON.stringify(shared), promotion.id, version],
    );
    if (result.affectedRows === 0) throw new PromotionConflictError();
  }
  writePromotionPaths(promotion.id, paths);
}

export async function readPromotionForUpdate(id: string): Promise<{ promotion: PromotionConfig; version: number } | undefined> {
  const [rows] = await (await db()).query<RowDataPacket[]>('SELECT data, version FROM promotions WHERE id = ?', [id]);
  return rows[0] ? { promotion: withLocalPaths(rows[0].data), version: Number(rows[0].version) } : undefined;
}

export async function deletePromotion(id: string): Promise<void> {
  await (await db()).query('DELETE FROM promotions WHERE id = ?', [id]);
}

const TEST_ENVS: readonly EnvKey[] = ['dev', 'staging', 'production'];

/** Sem `TEST_ENV` é staging; valor desconhecido falha em vez de virar staging e pular as travas de produção. */
export function currentTestEnv(): EnvKey {
  const value = process.env.TEST_ENV;
  if (!value) return 'staging';
  const env = TEST_ENVS.find((key) => key === value);
  if (!env) throw new Error(`TEST_ENV desconhecido: "${value}". Use ${TEST_ENVS.join(', ')} ou deixe vazio (staging).`);
  return env;
}

let activePromotion: Promise<PromotionConfig | undefined> | undefined;

/** Snapshot pro processo do Playwright; o servidor web lê do banco a cada chamada. */
export function findActivePromotion(): Promise<PromotionConfig | undefined> {
  activePromotion ??= (process.env.PROMO ? readPromotion(process.env.PROMO) : Promise.resolve(undefined)).catch((error: unknown) => {
    activePromotion = undefined;
    throw error;
  });
  return activePromotion;
}

export async function getActivePromotion(): Promise<PromotionConfig> {
  const id = process.env.PROMO;
  if (!id) {
    throw new Error('Env var PROMO é obrigatória, ex.: `PROMO=cliente-x-2026 npm test`.');
  }
  const promotion = await findActivePromotion();
  if (!promotion) {
    const known = (await listPromotions()).map((p) => p.id).join(', ') || '(nenhuma promoção cadastrada ainda)';
    throw new Error(`Promoção desconhecida "${id}". Cadastradas: ${known}`);
  }
  return promotion;
}
