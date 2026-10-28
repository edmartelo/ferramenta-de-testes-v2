import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { hasAtendimentos } from '../src/lib/atendimentos-panels.ts';
import { PROJECT_ROOT } from '../src/lib/paths.ts';
import { rootEnv } from '../src/lib/root-env.ts';
import { RUN_MARKERS } from '../src/lib/run-markers.ts';
import { recurrencesMessage, sendWhatsAppMessage } from '../src/lib/whatsapp.ts';
import type { PromoMonitorConnection } from './connectors-store.ts';
import { EXCLUSIVE_LOCK, progressMarkerReader, runPlaywrightJob, spawnPlaywrightNdjson, type EndFailure, type JobLock, type PlaywrightNdjsonRun } from './playwright-jobs.ts';

export interface RecurrencesPromotionResult {
  name: string;
  /** `.analytics-count` do card no Monitor de Promoções. */
  analyticsCount?: string;
  ok: boolean;
  /** Linhas do modal "Recorrências" com valor "sim" — cada uma é uma falha de mecânica. */
  failingLines: string[];
  /** Valor "DD/MM/AAAA HH:mm:ss" ou "nenhum"; nem todo card tem as quatro linhas. */
  registrationLines: { label: string; value: string }[];
  panelLinks: { label: string; url: string }[];
}

export type RecurrencesScanEvent =
  | { type: 'progress'; label: string; current?: number; total?: number; promotion?: RecurrencesPromotionResult }
  | { type: 'end'; success: true; promotions: RecurrencesPromotionResult[] }
  | EndFailure;

export type PromoMonitorCredentials = Omit<PromoMonitorConnection, 'connectedAt'>;

const RECURRENCES_OUTPUT_PATH = join(PROJECT_ROOT, '.recurrences-scan-output.json');
const RECURRENCES_REFRESH_OUTPUT_PATH = join(PROJECT_ROOT, '.recurrences-refresh-output.json');
/** `storageState` do Monitor de Promoções salvo pelo scan completo; a atualização da contagem reusa sem logar. */
const RECURRENCES_SESSION_PATH = join(PROJECT_ROOT, '.recurrences-session.json');
/** Grupo que recebe as Recorrências (`WHATSAPP_RECIPIENT_JID` no `.env`): o app WhatsApp MCP não envia para a própria conta pareada. */
function whatsappRecipientJid(): string {
  const jid = rootEnv('WHATSAPP_RECIPIENT_JID');
  if (!jid) throw new Error('defina WHATSAPP_RECIPIENT_JID no .env com o JID do grupo (ex.: 1203...@g.us).');
  return jid;
}

/** Lê a sessão que o scan completo regrava: não roda junto com nenhum job exclusivo. */
const RECURRENCES_REFRESH_LOCK: JobLock = {
  key: 'recurrences-refresh',
  busyMessage: 'A contagem de acessos já está sendo atualizada, ou há outra execução em andamento. Aguarde terminar.',
  conflictsWith: [EXCLUSIVE_LOCK.key],
};

export interface RecurrencesAccessCount {
  name: string;
  analyticsCount?: RecurrencesPromotionResult['analyticsCount'];
}

export type RecurrencesRefreshEvent = { type: 'end'; success: true; counts: RecurrencesAccessCount[] } | EndFailure;

export function hasRecurrencesSession(): boolean {
  return existsSync(RECURRENCES_SESSION_PATH);
}

export function runRecurrencesRefreshStreaming(res: ServerResponse): void {
  const outputPath = RECURRENCES_REFRESH_OUTPUT_PATH;
  const progress = progressMarkerReader<RecurrencesRefreshEvent>(RUN_MARKERS.recurrencesProgress, RUN_MARKERS.recurrencesError);
  spawnPlaywrightNdjson<RecurrencesRefreshEvent>(res, {
    lock: RECURRENCES_REFRESH_LOCK,
    runs: [['tests/_setup/recurrences-scan.spec.ts', '--workers=1', '--project=chromium']],
    env: { ...process.env, RECURRENCES_REFRESH: '1', RECURRENCES_OUTPUT_PATH: outputPath, RECURRENCES_SESSION_PATH },
    prepare: async () => {
      rmSync(outputPath, { force: true });
      return undefined;
    },
    onLine: progress.onLine,
    onClose: (code) => {
      if (code !== 0) return undefined;
      try {
        const { counts } = JSON.parse(readFileSync(outputPath, 'utf-8')) as { counts: RecurrencesAccessCount[] };
        return { type: 'end', success: true, counts };
      } catch {
        return { type: 'end', success: false, error: 'A atualização terminou mas não gerou o arquivo de resultado esperado.' };
      }
    },
    preferredError: progress.friendlyError,
  });
}

/** Links "Painel" do último scan com tela de atendimentos — os únicos pra onde a coleta de atendimentos pode mandar a senha. */
export function lastScannedPanelUrls(): Set<string> {
  try {
    const { promotions } = JSON.parse(readFileSync(RECURRENCES_OUTPUT_PATH, 'utf-8')) as { promotions: RecurrencesPromotionResult[] };
    return new Set(promotions.flatMap((promotion) => promotion.panelLinks.filter((link) => link.label === 'Painel' && hasAtendimentos(link.url)).map((link) => link.url)));
  } catch {
    return new Set();
  }
}

function recurrencesScanRun(credentials: PromoMonitorCredentials, totpCode: string | undefined): PlaywrightNdjsonRun<RecurrencesScanEvent> {
  const outputPath = RECURRENCES_OUTPUT_PATH;
  const progress = progressMarkerReader<RecurrencesScanEvent>(RUN_MARKERS.recurrencesProgress, RUN_MARKERS.recurrencesError);
  return {
    lock: EXCLUSIVE_LOCK,
    runs: [['tests/_setup/recurrences-scan.spec.ts', '--workers=1', '--project=chromium']],
    env: promoMonitorEnv(credentials, totpCode, { RECURRENCES_SCAN: '1', RECURRENCES_OUTPUT_PATH: outputPath, RECURRENCES_SESSION_PATH }),
    prepare: async () => {
      rmSync(outputPath, { force: true });
      return undefined;
    },
    onLine: progress.onLine,
    onClose: (code) => {
      if (code !== 0) return undefined;
      try {
        const { promotions } = JSON.parse(readFileSync(outputPath, 'utf-8')) as { promotions: RecurrencesPromotionResult[] };
        return { type: 'end', success: true, promotions };
      } catch {
        return { type: 'end', success: false, error: 'O scraper terminou mas não gerou o arquivo de resultado esperado.' };
      }
    },
    preferredError: progress.friendlyError,
  };
}

export function runRecurrencesScanStreaming(
  res: ServerResponse,
  credentials: PromoMonitorCredentials,
  totpCode: string | undefined,
  onEnd?: (event: Extract<RecurrencesScanEvent, { type: 'end' }>) => void,
): void {
  spawnPlaywrightNdjson(res, { ...recurrencesScanRun(credentials, totpCode), onEvent: (event) => event.type === 'end' && onEnd?.(event) });
}

/** Agendador: exige `totpSecret` no conector. `undefined` = outra execução ocupando o lock. */
export function runRecurrencesScanJob(credentials: PromoMonitorCredentials) {
  return runPlaywrightJob(recurrencesScanRun(credentials, undefined));
}

export function hasRecurrencesScanResult(): boolean {
  return existsSync(RECURRENCES_OUTPUT_PATH);
}

export function lastRecurrencesMessage(): string[] {
  return recurrencesMessage((JSON.parse(readFileSync(RECURRENCES_OUTPUT_PATH, 'utf-8')) as { promotions: RecurrencesPromotionResult[] }).promotions);
}

/** Sem `message`, manda o resultado do último scan completo. Devolve a mensagem de erro, ou `undefined` quando enviou. */
export async function sendRecurrencesWhatsApp(message?: string[], appendix: string[] = []): Promise<string | undefined> {
  try {
    const lines = message ?? lastRecurrencesMessage();
    await sendWhatsAppMessage(whatsappRecipientJid(), ['_Mensagem automática_', '', ...lines, ...appendix]);
    return undefined;
  } catch (error) {
    return `Não foi possível enviar no WhatsApp: ${(error as Error).message}`;
  }
}

/** `PROMO_MONITOR_TOTP_*` herdado de `process.env` nunca serve de fallback pro que veio do conector/modal. */
export function promoMonitorEnv(credentials: PromoMonitorCredentials, totpCode: string | undefined, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.PROMO_MONITOR_TOTP_SECRET;
  delete env.PROMO_MONITOR_TOTP_CODE;
  env.PROMO_MONITOR_EMAIL = credentials.email;
  env.PROMO_MONITOR_PASSWORD = credentials.password;
  if (totpCode) env.PROMO_MONITOR_TOTP_CODE = totpCode;
  else if (credentials.totpSecret) env.PROMO_MONITOR_TOTP_SECRET = credentials.totpSecret;
  return env;
}

/** Painel de cada promoção do último scan completo de Recorrências. */
export function scannedPromotionPanels(): { promotionName: string; panelUrl: string }[] {
  try {
    const { promotions } = JSON.parse(readFileSync(RECURRENCES_OUTPUT_PATH, 'utf-8')) as { promotions: RecurrencesPromotionResult[] };
    return promotions.flatMap((promotion) => {
      const panelUrl = promotion.panelLinks.find((link) => link.label === 'Painel')?.url;
      return panelUrl && hasAtendimentos(panelUrl) ? [{ promotionName: promotion.name, panelUrl }] : [];
    });
  } catch {
    return [];
  }
}

/** Linhas "Último cadastro …" da promoção no último scan completo, com a hora do scan (mtime do arquivo). */
export function scannedRegistrationLines(promotionName: string): { scannedAt: Date; lines: RecurrencesPromotionResult['registrationLines'] } | undefined {
  try {
    const { promotions } = JSON.parse(readFileSync(RECURRENCES_OUTPUT_PATH, 'utf-8')) as { promotions: RecurrencesPromotionResult[] };
    const promotion = promotions.find((entry) => entry.name === promotionName);
    return promotion && { scannedAt: statSync(RECURRENCES_OUTPUT_PATH).mtime, lines: promotion.registrationLines };
  } catch {
    return undefined;
  }
}
