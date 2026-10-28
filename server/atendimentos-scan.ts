import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createLimiter } from '../src/lib/limiter.ts';
import { PROJECT_ROOT } from '../src/lib/paths.ts';
import { RUN_MARKERS } from '../src/lib/run-markers.ts';
import { slugify } from '../src/lib/slug.ts';
import { progressMarkerReader, runPlaywrightJob, spawnPlaywrightNdjson, type EndFailure, type PlaywrightNdjsonRun } from './playwright-jobs.ts';
import { promoMonitorEnv, type PromoMonitorCredentials } from './recurrences-scan.ts';

export interface Atendimento {
  id: string;
  participante: string;
  assunto: string;
  dataRecebimento: string;
  status: string;
  /** Texto do popover do botão `bi-eye` (só hover, nunca clique). */
  mensagem: string;
}

export interface AtendimentosScanResult {
  promotionName: string;
  panelUrl: string;
  scannedAt: string;
  atendimentos: Atendimento[];
}

export type AtendimentosScanEvent =
  | { type: 'progress'; label: string; collected: number; atendimento?: Atendimento }
  | ({ type: 'end'; success: true } & AtendimentosScanResult)
  | EndFailure;

const ATENDIMENTOS_DIR = join(PROJECT_ROOT, '.atendimentos');
/** Mais que isso sem nova coleta, o arquivo é de promoção que saiu do Monitor: dado pessoal sem uso. */
const ATENDIMENTOS_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Gitignored, com dados pessoais de propósito (conferência manual). */
function atendimentosOutputPath(promotionName: string): string {
  return join(ATENDIMENTOS_DIR, `${slugify(promotionName) || 'promocao'}.json`);
}

/** `_resumos.json` (sem dado de participante) fica. */
export function purgeOldAtendimentos(): void {
  if (!existsSync(ATENDIMENTOS_DIR)) return;
  for (const file of readdirSync(ATENDIMENTOS_DIR)) {
    const path = join(ATENDIMENTOS_DIR, file);
    if (file.startsWith('_') || !file.endsWith('.json') || Date.now() - statSync(path).mtimeMs < ATENDIMENTOS_RETENTION_MS) continue;
    rmSync(path, { force: true });
  }
}

export function readAtendimentosResult(promotionName: string): AtendimentosScanResult | undefined {
  try {
    return JSON.parse(readFileSync(atendimentosOutputPath(promotionName), 'utf-8')) as AtendimentosScanResult;
  } catch {
    return undefined;
  }
}

/** Somente leitura em produção (trava no spec); lock por arquivo de saída, pra rodar promoções em paralelo. */
export function runAtendimentosScanStreaming(
  res: ServerResponse,
  credentials: PromoMonitorCredentials,
  totpCode: string | undefined,
  target: { promotionName: string; panelUrl: string },
  onEnd?: (event: Extract<AtendimentosScanEvent, { type: 'end' }>) => void,
): void {
  spawnPlaywrightNdjson<AtendimentosScanEvent>(res, { ...atendimentosScanRun(credentials, totpCode, target), onEvent: (event) => event.type === 'end' && onEnd?.(event) });
}

/** Pro agendador. `undefined` = já há coleta dessa promoção em andamento. */
export function runAtendimentosScanJob(credentials: PromoMonitorCredentials, target: { promotionName: string; panelUrl: string }) {
  return runPlaywrightJob(atendimentosScanRun(credentials, undefined, target));
}

/** Cada coleta é um Chromium logando num painel de produção, na mesma máquina do Ollama. Em globalThis pelo restart do Vite. */
const atendimentosScanSlots: ReturnType<typeof createLimiter> = ((globalThis as unknown as { __atendimentosScanSlots?: ReturnType<typeof createLimiter> }).__atendimentosScanSlots ??= createLimiter(2));

function atendimentosScanRun(
  credentials: PromoMonitorCredentials,
  totpCode: string | undefined,
  target: { promotionName: string; panelUrl: string },
): PlaywrightNdjsonRun<AtendimentosScanEvent> {
  const outputPath = atendimentosOutputPath(target.promotionName);
  const progress = progressMarkerReader<AtendimentosScanEvent>(RUN_MARKERS.atendimentosProgress, RUN_MARKERS.atendimentosError);
  const panelTotpSecret = credentials.panelTotpSecrets?.[new URL(target.panelUrl).hostname];
  if (panelTotpSecret) {
    credentials = { ...credentials, totpSecret: panelTotpSecret };
    totpCode = undefined;
  }
  return {
    lock: { key: `atendimentos:${outputPath}`, busyMessage: 'Já existe uma coleta de atendimentos em andamento para essa promoção. Aguarde terminar ou cancele antes de iniciar outra.' },
    runs: [['tests/_setup/atendimentos-scan.spec.ts', '--workers=1', '--project=chromium']],
    env: promoMonitorEnv(credentials, totpCode, {
      ATENDIMENTOS_SCAN: '1',
      ATENDIMENTOS_PANEL_URL: target.panelUrl,
      ATENDIMENTOS_PROMOTION_NAME: target.promotionName,
      ATENDIMENTOS_OUTPUT_PATH: outputPath,
    }),
    prepare: async (write) => {
      // Código digitado no modal vence em segundos: esse login não pode esperar vaga.
      let release = totpCode ? undefined : atendimentosScanSlots.tryAcquire();
      if (!totpCode && !release) {
        write({ type: 'progress', label: 'Na fila: aguardando outra coleta de atendimentos terminar', collected: 0 });
        release = await atendimentosScanSlots.acquire();
      }
      rmSync(outputPath, { force: true });
      return release && (async () => release());
    },
    onLine: progress.onLine,
    onClose: (code) => {
      if (code !== 0) return undefined;
      const result = readAtendimentosResult(target.promotionName);
      return result
        ? { type: 'end', success: true, ...result }
        : { type: 'end', success: false, error: 'A coleta terminou mas não gerou o arquivo de resultado esperado.' };
    },
    preferredError: progress.friendlyError,
  };
}
