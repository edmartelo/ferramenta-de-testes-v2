import { readdirSync } from 'node:fs';
import { archiveDeletedPromotionFolders } from '../promotions/index.ts';
import { PROMOTIONS_ROOT } from '../src/lib/paths.ts';
import { encryptStoredCredentials } from '../src/lib/promotion-credentials.ts';
import { purgeOldAtendimentos } from './atendimentos-scan.ts';
import { encryptStoredConnectors } from './connectors-store.ts';

const INTERVAL_MS = 60 * 60_000;

const housekeeping = globalThis as unknown as { __localHousekeeping?: ReturnType<typeof setInterval> };

/** Arquivos desta máquina: cifra segredos antigos, arquiva promoções excluídas e apaga atendimentos vencidos. */
export function startLocalHousekeeping(onError: (message: string) => void): void {
  const run = async () => {
    const steps: [string, () => void | Promise<void>][] = [
      ['cifrar conectores', encryptStoredConnectors],
      ['cifrar credenciais', encryptPromotionCredentials],
      ['arquivar promoções excluídas', archiveDeletedPromotionFolders],
      ['apagar atendimentos antigos', purgeOldAtendimentos],
    ];
    for (const [label, step] of steps) {
      try {
        await step();
      } catch (error) {
        onError(`Manutenção local (${label}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  clearInterval(housekeeping.__localHousekeeping);
  housekeeping.__localHousekeeping = setInterval(() => void run(), INTERVAL_MS);
  void run();
}

function encryptPromotionCredentials(): void {
  for (const entry of readdirSync(PROMOTIONS_ROOT, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('_')) encryptStoredCredentials(entry.name);
  }
}
