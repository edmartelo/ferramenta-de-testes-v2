import { join } from 'node:path';
import { db } from '../src/lib/db.ts';
import { readJsonFile, writeJsonFile } from '../src/lib/json-file.ts';
import { PROJECT_ROOT } from '../src/lib/paths.ts';
import { ensureSharedDbRunning } from './aiven-power.ts';
import { rememberSummary, summarizeAtendimentos, summaryWhatsAppLines } from './atendimentos-summary.ts';
import { runAtendimentosScanJob } from './atendimentos-scan.ts';
import { getPromoMonitorConnection } from './connectors-store.ts';
import { durationDetail, promotionsScanDetails, recordLog, type LogDetails } from './logs.ts';
import { runRecurrencesScanJob, scannedPromotionPanels, sendRecurrencesWhatsApp } from './recurrences-scan.ts';

export const SCHEDULE_SLOTS = ['10:00', '14:00', '18:00', '21:00'];
/** Por máquina, fora do banco: cada pessoa liga a automação no próprio `npm run dev`. */
const SETTING_PATH = join(PROJECT_ROOT, '.recurrences-schedule.json');
const TICK_MS = 30_000;
/** Com outra execução ocupando o lock, tenta de novo a cada 2 min até 30 min depois do horário. */
const RETRY_INTERVAL_MS = 2 * 60_000;
const RETRY_WINDOW_MS = 30 * 60_000;
/** Liga o banco no Aiven com folga (religar leva alguns minutos) e confere a cada 5 min até ele estar no ar ou a janela da consulta acabar. */
const POWER_ON_LEAD_MS = 30 * 60_000;
const POWER_ON_INTERVAL_MS = 5 * 60_000;

interface ScheduleSetting {
  enabled: boolean;
  /** Dono do conector Monitor de Promoções usado nas consultas: quem ligou o agendamento. */
  userId?: string;
}

export interface ScheduleLastRun {
  slot: string;
  at: string;
  ok: boolean;
  message: string;
}

export interface ScheduleStatus {
  enabled: boolean;
  slots: string[];
  lastRun?: ScheduleLastRun;
}

interface SchedulerState {
  setting: ScheduleSetting;
  day: string;
  done: Set<string>;
  lastAttemptAt: Map<string, number>;
  powerOn: Map<string, { lastAttemptAt: number; running: boolean; warned: boolean; dbDown?: boolean }>;
  running: boolean;
  lastRun?: ScheduleLastRun;
  timer?: ReturnType<typeof setInterval>;
}

// Em globalThis: sobrevive ao restart do Vite (tentativas do dia, último resultado, timer).
const globalState = globalThis as unknown as { __recurrencesScheduler?: SchedulerState };
const state: SchedulerState = (globalState.__recurrencesScheduler ??= {
  setting: { enabled: false },
  day: '',
  done: new Set(),
  lastAttemptAt: new Map(),
  powerOn: new Map(),
  running: false,
});
state.powerOn ??= new Map();
let logError: (message: string) => void = () => {};

function loadSetting(): ScheduleSetting {
  return readJsonFile<ScheduleSetting>(SETTING_PATH, { enabled: false });
}

function saveSetting(setting: ScheduleSetting): void {
  writeJsonFile(SETTING_PATH, setting);
}

export function getScheduleStatus(): ScheduleStatus {
  return { enabled: state.setting.enabled, slots: SCHEDULE_SLOTS, lastRun: state.lastRun };
}

export async function setScheduleEnabled(enabled: boolean, userId: string): Promise<ScheduleStatus> {
  if (enabled && !getPromoMonitorConnection(userId)?.totpSecret) {
    throw new Error('O envio automático precisa da chave do autenticador salva em Configurações → Conectores → Monitor de Promoções.');
  }
  const setting = enabled ? { enabled, userId } : { ...state.setting, enabled };
  saveSetting(setting);
  state.setting = setting;
  return getScheduleStatus();
}

export function startRecurrencesScheduler(onError: (message: string) => void): void {
  logError = onError;
  try {
    state.setting = loadSetting();
  } catch (error) {
    onError(`Agendamento de Recorrências: ${(error as Error).message}`);
  }
  // O restart do Vite reimporta este módulo: o timer antigo rodaria o `tick` da versão anterior.
  clearInterval(state.timer);
  state.timer = setInterval(() => void tick().catch((error: Error) => onError(`Agendamento de Recorrências: ${error.message}`)), TICK_MS);
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function slotTime(now: Date, slot: string): number {
  const [hours, minutes] = slot.split(':').map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes).getTime();
}

function shortError(error: string): string {
  return (error.split('\n')[0] ?? '').slice(0, 300);
}

async function tick(): Promise<void> {
  if (!state.setting.enabled) return;
  const now = new Date();
  const day = localDay(now);
  if (day !== state.day) {
    state.day = day;
    state.done.clear();
    state.lastAttemptAt.clear();
    state.powerOn.clear();
  }
  await powerOnBeforeSlots(now);
  if (state.running) return;
  for (const slot of SCHEDULE_SLOTS) {
    const start = slotTime(now, slot);
    if (state.done.has(slot) || now.getTime() < start) continue;
    if (now.getTime() - start > RETRY_WINDOW_MS) {
      state.done.add(slot);
      if (state.lastAttemptAt.has(slot)) finishRun(slot, false, 'Não rodou: outra execução ocupou a ferramenta por 30 min.');
      else if (state.powerOn.get(slot)?.dbDown) {
        const whatsappError = await notify([`Recorrências: consulta das ${slot} não rodou — o banco não respondeu em 30 min.`]);
        finishRun(slot, false, `Não rodou: o banco não respondeu em 30 min.${whatsappError ? ` (WhatsApp: ${whatsappError})` : ''}`);
      }
      continue;
    }
    const lastAttempt = state.lastAttemptAt.get(slot);
    if (lastAttempt && now.getTime() - lastAttempt < RETRY_INTERVAL_MS) continue;
    // Sem banco o resumo sai sem as correções do Aprendizado: espera ele voltar dentro da janela.
    if (!(await sharedDbResponds())) {
      const attempt = state.powerOn.get(slot);
      if (attempt) attempt.dbDown = true;
      continue;
    }
    state.lastAttemptAt.set(slot, now.getTime());
    state.running = true;
    try {
      await runSlot(slot);
    } catch (error) {
      state.done.add(slot);
      const message = shortError(error instanceof Error ? error.message : String(error));
      const whatsappError = await notify([`Recorrências: consulta das ${slot} falhou — ${message}`]);
      finishRun(slot, false, `Erro inesperado: ${message}${whatsappError ? ` (WhatsApp: ${whatsappError})` : ''}`);
      throw error;
    } finally {
      state.running = false;
    }
    return;
  }
}

async function sharedDbResponds(): Promise<boolean> {
  try {
    await (await db()).query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function powerOnBeforeSlots(now: Date): Promise<void> {
  for (const slot of SCHEDULE_SLOTS) {
    const start = slotTime(now, slot);
    if (now.getTime() < start - POWER_ON_LEAD_MS || now.getTime() > start + RETRY_WINDOW_MS) continue;
    const attempt = state.powerOn.get(slot) ?? { lastAttemptAt: 0, running: false, warned: false };
    if (attempt.running || now.getTime() - attempt.lastAttemptAt < POWER_ON_INTERVAL_MS) continue;
    attempt.lastAttemptAt = now.getTime();
    state.powerOn.set(slot, attempt);
    const power = await ensureSharedDbRunning();
    attempt.running = power.running;
    if (!power.error) continue;
    const message = `Recorrências: não consegui ligar o banco para a consulta das ${slot} — ${shortError(power.error)}`;
    logError(message);
    if (attempt.warned) continue;
    attempt.warned = true;
    const whatsappError = await notify([message]);
    if (whatsappError) logError(`Recorrências: aviso do banco não foi pro WhatsApp — ${whatsappError}`);
  }
}

async function runSlot(slot: string): Promise<void> {
  const connection = state.setting.userId ? getPromoMonitorConnection(state.setting.userId) : undefined;
  if (!connection?.totpSecret) {
    state.done.add(slot);
    const message = 'Monitor de Promoções sem chave do autenticador no conector.';
    await notify([`Recorrências: consulta das ${slot} falhou — ${message}`]);
    return finishRun(slot, false, message);
  }

  const startedAt = Date.now();
  const scan = runRecurrencesScanJob(connection);
  if (!scan) return;
  state.done.add(slot);
  const result = await scan;

  const scanError = result.success ? undefined : shortError(result.error);
  const atendimentos = scanError ? undefined : await atendimentosSummaryAppendix(connection);
  const whatsappError = await notify(scanError ? [`Recorrências: consulta das ${slot} falhou — ${scanError}`] : undefined, atendimentos?.lines);
  const failedPanels = atendimentos?.failedPromotions ?? [];
  const details: LogDetails = result.success
    ? {
        ...promotionsScanDetails(result.promotions),
        paineisAtendimentos: atendimentos?.panels ?? 0,
        paineisComErro: failedPanels.length,
        ...(failedPanels.length > 0 && { paineisQueFalharam: failedPanels.join(', ') }),
        whatsappEnviado: !whatsappError,
        duracao: durationDetail(startedAt),
      }
    : { duracao: durationDetail(startedAt) };
  if (scanError) return finishRun(slot, false, `Consulta falhou: ${scanError}${whatsappError ? ` (WhatsApp: ${whatsappError})` : ''}`, details);
  if (whatsappError) return finishRun(slot, false, `Consulta ok, mas o WhatsApp falhou: ${whatsappError}`, details);
  finishRun(slot, true, 'Consulta feita e resultado enviado no WhatsApp.', details);
}

/** Devolve a mensagem de erro, ou `undefined` quando enviou. */
async function notify(message: string[] | undefined, appendix: string[] = []): Promise<string | undefined> {
  const error = await sendRecurrencesWhatsApp(message, appendix);
  return error && shortError(error);
}

/** Coleta atendimentos de todo painel (a fila de coletas e a do Ollama ficam no servidor); falha vira linha de aviso. */
async function atendimentosSummaryAppendix(
  connection: NonNullable<ReturnType<typeof getPromoMonitorConnection>>,
): Promise<{ lines: string[]; panels: number; failedPromotions: string[] }> {
  const targets = scannedPromotionPanels();
  const scans = await Promise.all(
    targets.map(async (target) => {
      const scan = runAtendimentosScanJob(connection, target);
      return { target, result: scan ? await scan : { success: false as const, error: 'já havia uma coleta em andamento' } };
    }),
  );
  const summarized: string[] = [];
  const failures: string[] = [];
  const failedPromotions: string[] = [];
  for (const { target, result } of scans) {
    if (!result.success) {
      failedPromotions.push(target.promotionName);
      failures.push(`⚠️ Atendimentos de ${target.promotionName}: falhou — ${shortError(result.error)}`);
      continue;
    }
    rememberSummary(await summarizeAtendimentos(target.promotionName, result.atendimentos));
    summarized.push(target.promotionName);
  }
  const lines = [...summaryWhatsAppLines(summarized), ...(failures.length > 0 ? ['', ...failures] : [])];
  return { lines: lines.length > 0 ? ['', ...lines] : [], panels: targets.length, failedPromotions };
}

function finishRun(slot: string, ok: boolean, message: string, details?: LogDetails): void {
  state.lastRun = { slot, at: new Date().toISOString(), ok, message };
  recordLog({ source: 'recorrencias', trigger: 'agendada', userId: state.setting.userId, action: `Consulta das ${slot}`, ok, message, details }, logError);
}
