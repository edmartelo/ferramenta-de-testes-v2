import { readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
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

/** Promoção excluída em outra máquina: a pasta daqui (credenciais, sessão de painel, pastas) é arquivada, pra uma recriada com o mesmo slug não herdar nada. */
function archiveDeletedPromotionFolders(ids: Set<string>): void {
  const stamp = new Date().toISOString().slice(0, 10);
  for (const entry of readdirSync(PROMOTIONS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || ids.has(entry.name)) continue;
    const dir = join(PROMOTIONS_ROOT, entry.name);
    if (Date.now() - statSync(dir).mtimeMs < ARCHIVE_MIN_AGE_MS) continue;
    try {
      renameSync(dir, join(PROMOTIONS_ROOT, `_excluida-${entry.name}-${stamp}`));
    } catch {
      // No Windows a pasta aberta por outro processo dá EPERM: tenta na próxima listagem, sem derrubar esta.
    }
  }
}

export async function listPromotions(): Promise<PromotionConfig[]> {
  const [rows] = await (await db()).query<RowDataPacket[]>('SELECT data FROM promotions ORDER BY id');
  const promotions = rows.map((row) => withLocalPaths(row.data));
  // Banco vazio é mais provável problema do banco que todas excluídas: não arquiva nada.
  if (promotions.length > 0) archiveDeletedPromotionFolders(new Set(promotions.map((promotion) => promotion.id)));
  return promotions;
}

export async function promotionExists(id: string): Promise<boolean> {
  const [rows] = await (await db()).query<RowDataPacket[]>('SELECT 1 FROM promotions WHERE id = ?', [id]);
  return rows.length > 0;
}

export async function writePromotion(promotion: PromotionConfig): Promise<void> {
  const { paths, ...shared } = promotion;
  await (await db()).query(
    'INSERT INTO promotions (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)',
    [promotion.id, JSON.stringify(shared)],
  );
  writePromotionPaths(promotion.id, paths);
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
