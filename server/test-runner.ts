import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { constants } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { TEST_GROUPS, type TestGroup } from '../knowledge-base/test-groups.ts';
import { hasAtendimentos } from './atendimentos-panels.ts';
import { readPromotion } from '../promotions/index.ts';
import type { EnvKey } from '../promotions/types.ts';
import { DEV_PROJECT_MANAGED_ENV, killLiveChildren, killProcessTree, startDevProject, trackChild } from '../src/lib/dev-bootstrap.ts';
import { PROJECT_ROOT } from '../src/lib/paths.ts';
import { rootEnv } from '../src/lib/root-env.ts';
import { RUN_MARKERS } from '../src/lib/run-markers.ts';
import { recurrencesMessage, sendWhatsAppMessage } from '../src/lib/whatsapp.ts';
import type { PromoMonitorConnection } from './connectors-api.ts';
import { sendJson } from './http-utils.ts';

/** `node <cli.js>` sem shell: no Windows o `cmd.exe` mata o processo (código 255) com `(`, `)`, `|` de um `--grep`. */
const PLAYWRIGHT_CLI = createRequire(import.meta.url).resolve('@playwright/test/cli');

const RESULTS_ROOT = join(PROJECT_ROOT, 'test-results');

interface JobLock {
  key: string;
  busyMessage: string;
}

/** Testes, login no painel e Recorrências dividem porta, sessão e arquivo de saída: um de cada vez. */
const EXCLUSIVE_LOCK: JobLock = {
  key: 'exclusive',
  busyMessage: 'Já existe uma execução em andamento (testes, login no painel ou Recorrências). Aguarde terminar ou cancele antes de iniciar outra.',
};

const activeJobs = new Set<string>();
/** `--output` de jobs deste processo que já terminaram; em globalThis pra sobreviver ao restart do Vite. */
const finishedOutputDirs: Set<string> = ((globalThis as unknown as { __finishedOutputDirs?: Set<string> }).__finishedOutputDirs ??= new Set());

/** Só apaga saída de job deste processo que já terminou: `npm test` pela CLI e job rodando ficam intactos. */
function pruneFinishedResults(): void {
  for (const entry of finishedOutputDirs) {
    try {
      rmSync(join(RESULTS_ROOT, entry), { recursive: true, force: true });
      finishedOutputDirs.delete(entry);
    } catch {
      // arquivo preso por outro processo no Windows
    }
  }
}

// Só no servidor web e uma vez por processo: o restart do Vite reimporta este módulo.
const exitHooks = globalThis as unknown as { __killChildrenOnExit?: boolean };
if (!exitHooks.__killChildrenOnExit) {
  exitHooks.__killChildrenOnExit = true;
  process.once('exit', killLiveChildren);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      killLiveChildren();
      // Ouvir o sinal tira a saída padrão do Node; o SIGTERM do Vite já fecha o servidor e sai sozinho.
      if (process.listenerCount(signal) === 0) process.exit(128 + constants.signals[signal]);
    });
  }
}

type EndFailure = { type: 'end'; success: false; error: string };

interface PlaywrightNdjsonRun<E> {
  lock: JobLock;
  /** Um item por processo, em sequência: código 1 (teste falhou) segue, outro código não-zero encerra. */
  runs: string[][];
  env: NodeJS.ProcessEnv;
  /** A função devolvida roda no fim, ou quando a pessoa cancela. */
  prepare?: (write: (event: E) => void) => Promise<(() => Promise<void>) | undefined>;
  onLine?: (line: string, write: (event: E) => void) => void;
  /** `undefined` = falha genérica (ver `preferredError`). */
  onClose: (code: number | null) => E | undefined;
  preferredError?: () => string;
  /** Tudo que vai pra resposta, mais um `end` de cancelamento quando a pessoa aborta. */
  onEvent?: (event: E | EndFailure) => void;
}

interface JobOutput<E> {
  write(event: E | EndFailure): void;
  end(): void;
  onCancel(cancel: () => void): void;
}

const PLAYWRIGHT_ERROR_LINE = /^\s*(\w*Error: |Test timeout of )/;

function spawnPlaywrightNdjson<E extends object>(res: ServerResponse, run: PlaywrightNdjsonRun<E>): void {
  if (activeJobs.has(run.lock.key)) {
    sendJson(res, 409, { error: run.lock.busyMessage });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
  startPlaywrightJob(run, {
    write: (event) => res.write(JSON.stringify(event) + '\n'),
    end: () => res.end(),
    onCancel: (cancel) => res.on('close', cancel),
  });
}

/** Sem resposta HTTP, pro agendador e pelas rodadas pedidas pelo site. `undefined` = lock ocupado. */
function runPlaywrightJob<E extends { type: string }>(run: PlaywrightNdjsonRun<E>, signal?: AbortSignal): Promise<Extract<E, { type: 'end' }> | EndFailure> | undefined {
  if (activeJobs.has(run.lock.key)) return undefined;
  return new Promise((resolve) => {
    // O `end` do cancelamento só passa pelo `onEvent`, sem `output.end()`.
    const onEvent = (event: E | EndFailure) => {
      run.onEvent?.(event);
      if (event.type === 'end') resolve(event as Extract<E, { type: 'end' }> | EndFailure);
    };
    startPlaywrightJob({ ...run, onEvent }, {
      write: () => {},
      end: () => {},
      onCancel: (cancel) => signal?.addEventListener('abort', cancel, { once: true }),
    });
  });
}

export function isExclusiveJobRunning(): boolean {
  return activeJobs.has(EXCLUSIVE_LOCK.key);
}

/** O reporter `line` manda a falha pro stdout, então o erro de fallback é a primeira linha de erro dele. */
function startPlaywrightJob<E extends object>(run: PlaywrightNdjsonRun<E>, output: JobOutput<E>): void {
  activeJobs.add(run.lock.key);
  const outputName = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  pruneFinishedResults();
  function release(): void {
    activeJobs.delete(run.lock.key);
    finishedOutputDirs.add(outputName);
  }

  let ended = false;
  function write(event: E | EndFailure): void {
    if (ended) return;
    run.onEvent?.(event);
    output.write(event);
  }
  function finish(event: E | EndFailure): void {
    if (ended) return;
    write(event);
    ended = true;
    output.end();
  }

  let stdoutError = '';
  let stderrTail = '';
  let child: ChildProcess | undefined;
  let teardown: (() => Promise<void>) | undefined;
  let tornDown = false;
  let aborted = false;

  async function tearDownOnce(): Promise<void> {
    if (!teardown || tornDown) return;
    tornDown = true;
    await teardown();
  }

  function spawnOne(args: string[]): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const current = trackChild(spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', ...args, `--output=test-results/${outputName}`], { cwd: PROJECT_ROOT, env: run.env }));
      child = current;
      current.stdout.setEncoding('utf8');
      current.stderr.setEncoding('utf8');
      let stdoutBuffer = '';
      current.stdout.on('data', (text: string) => {
        stdoutBuffer += text;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!stdoutError && PLAYWRIGHT_ERROR_LINE.test(line)) stdoutError = line.trim();
          run.onLine?.(line, write);
        }
      });
      current.stderr.on('data', (text: string) => {
        stderrTail = (stderrTail + text).slice(-4000);
      });
      current.on('error', reject);
      current.on('close', resolve);
    });
  }

  async function runSequence(): Promise<number | null> {
    teardown = await run.prepare?.(write);
    let result: number | null = 0;
    try {
      for (const args of run.runs) {
        if (aborted) break;
        const code = await spawnOne(args);
        if (code === 1) result = 1;
        else if (code !== 0) return code;
      }
      return result;
    } finally {
      await tearDownOnce();
    }
  }

  output.onCancel(() => {
    if (ended) return;
    aborted = true;
    if (child) killProcessTree(child);
  });

  // Lock só sai depois do último processo e do teardown, mesmo se a pessoa cancelou.
  runSequence()
    .finally(release)
    .then(
      (code) => {
        if (aborted) return run.onEvent?.({ type: 'end', success: false, error: 'Execução cancelada.' });
        finish(
          run.onClose(code) ?? {
            type: 'end',
            success: false,
            error: run.preferredError?.() || stderrTail.trim() || stdoutError || `Processo encerrou com código ${code}.`,
          },
        );
      },
      (err: Error) => finish({ type: 'end', success: false, error: `Falha ao iniciar: ${err.message}` }),
    );
}

interface AuthenticatePanelOptions {
  promotionId: string;
  envKey: EnvKey;
  email: string;
  password: string;
  /** Digitado no modal, nunca persistido. Ausente só quando há `totpSecret`. */
  totpCode?: string;
  totpSecret?: string;
}

export type AuthenticatePanelEvent = { type: 'end'; success: boolean; error?: string };

function adminPanelLoginRun(options: AuthenticatePanelOptions): PlaywrightNdjsonRun<AuthenticatePanelEvent> {
  let friendlyError = '';
  return {
    lock: EXCLUSIVE_LOCK,
    runs: [['tests/_setup/admin-panel-login.spec.ts', '--workers=1', '--project=chromium']],
    env: {
      ...process.env,
      PROMO: options.promotionId,
      TEST_ENV: options.envKey,
      ADMIN_PANEL_LOGIN_SETUP: '1',
      ADMIN_PANEL_LOGIN_EMAIL: options.email,
      ADMIN_PANEL_LOGIN_PASSWORD: options.password,
      ...(options.totpCode ? { ADMIN_PANEL_LOGIN_TOTP_CODE: options.totpCode } : {}),
      ...(options.totpSecret ? { ADMIN_PANEL_LOGIN_TOTP_SECRET: options.totpSecret } : {}),
    },
    onLine: (line) => {
      if (line.startsWith(RUN_MARKERS.adminPanelLoginError)) {
        friendlyError = line.slice(RUN_MARKERS.adminPanelLoginError.length).trim();
      }
    },
    onClose: (code) => (code === 0 ? { type: 'end', success: true } : undefined),
    preferredError: () => friendlyError,
  };
}

export function runAdminPanelLoginStreaming(options: AuthenticatePanelOptions, res: ServerResponse): void {
  spawnPlaywrightNdjson(res, adminPanelLoginRun(options));
}

export function runAdminPanelLoginJob(options: AuthenticatePanelOptions, signal?: AbortSignal) {
  return runPlaywrightJob(adminPanelLoginRun(options), signal);
}

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

type PromoMonitorCredentials = Omit<PromoMonitorConnection, 'connectedAt'>;

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

const RECURRENCES_REFRESH_LOCK: JobLock = {
  key: 'recurrences-refresh',
  busyMessage: 'A contagem de acessos já está sendo atualizada.',
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
function promoMonitorEnv(credentials: PromoMonitorCredentials, totpCode: string | undefined, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.PROMO_MONITOR_TOTP_SECRET;
  delete env.PROMO_MONITOR_TOTP_CODE;
  env.PROMO_MONITOR_EMAIL = credentials.email;
  env.PROMO_MONITOR_PASSWORD = credentials.password;
  if (totpCode) env.PROMO_MONITOR_TOTP_CODE = totpCode;
  else if (credentials.totpSecret) env.PROMO_MONITOR_TOTP_SECRET = credentials.totpSecret;
  return env;
}

function progressMarkerReader<E extends { type: string }>(progressMarker: string, errorMarker: string) {
  let friendlyError = '';
  return {
    onLine(line: string, write: (event: E) => void): void {
      if (line.startsWith(errorMarker)) {
        friendlyError = line.slice(errorMarker.length).trim();
        return;
      }
      if (!line.startsWith(progressMarker)) return;
      try {
        write({ type: 'progress', ...JSON.parse(line.slice(progressMarker.length)) } as E);
      } catch {
        // linha de progresso corrompida — ignora
      }
    },
    friendlyError: () => friendlyError,
  };
}

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

/** Gitignored, com dados pessoais de propósito (conferência manual). */
function atendimentosOutputPath(promotionName: string): string {
  const slug = promotionName.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return join(PROJECT_ROOT, '.atendimentos', `${slug || 'promocao'}.json`);
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
    prepare: async () => {
      rmSync(outputPath, { force: true });
      return undefined;
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

export type TestRunEvent =
  | { type: 'begin'; total: number }
  | { type: 'test-begin'; id: string; title: string }
  | { type: 'test-end'; id: string; title: string; status: 'ok' | 'failed' | 'not-applicable'; detail?: string }
  | { type: 'error'; message?: string }
  | { type: 'status'; message: string }
  | { type: 'end'; success: boolean; error?: string };

export interface RunTestSuiteOptions {
  promotionId: string;
  envKey: EnvKey;
  headed: boolean;
  testDirectories: string[];
  extraArgs?: string[];
  extraEnv?: NodeJS.ProcessEnv;
  onEvent?: (event: TestRunEvent) => void;
}

interface AvailableTestGroup extends TestGroup {
  available: boolean;
  directory: string;
}

function withDirectory(group: TestGroup): AvailableTestGroup {
  const directory = `tests/${group.folder}`;
  const absolute = join(PROJECT_ROOT, directory);
  const available = existsSync(absolute) && readdirSync(absolute).some((file) => file.endsWith('.spec.ts'));
  return { ...group, available, directory };
}

export function testGroups(): AvailableTestGroup[] {
  return TEST_GROUPS.map(withDirectory);
}

/** Um `playwright test` por grupo, em sequência (`dependencies` pularia grupos após falha); o primeiro é `--list` pro total. */
function testSuiteRun(options: RunTestSuiteOptions): PlaywrightNdjsonRun<TestRunEvent> {
  const reporter = ['--reporter=./server/progress-reporter.ts', '--pass-with-no-tests'];
  const headed = options.headed ? ['--headed', '--workers=1'] : [];
  const extra = options.extraArgs ?? [];
  const runs = [
    [...options.testDirectories, '--list', ...reporter, ...extra],
    ...options.testDirectories.map((directory) => [directory, ...reporter, ...headed, ...extra]),
  ];

  const runErrors: string[] = [];
  let testsFinished = 0;
  let totalSent = false;
  return {
    lock: EXCLUSIVE_LOCK,
    runs,
    env: { ...process.env, ...options.extraEnv, PROMO: options.promotionId, TEST_ENV: options.envKey, [DEV_PROJECT_MANAGED_ENV]: '1' },
    prepare: async (write) => {
      const promotion = options.envKey === 'dev' ? await readPromotion(options.promotionId) : undefined;
      return promotion
        ? startDevProject(promotion, (message) => {
            console.log(`[dev-bootstrap] ${message}`);
            write({ type: 'status', message });
          })
        : undefined;
    },
    onLine: (line, write) => {
      if (!line.startsWith(RUN_MARKERS.testProgress)) return;
      try {
        const event = JSON.parse(line.slice(RUN_MARKERS.testProgress.length)) as TestRunEvent | { type: 'end'; status: string };
        if (event.type === 'end') return;
        if (event.type === 'begin') {
          if (totalSent) return;
          totalSent = true;
        }
        if (event.type === 'error' && event.message) runErrors.push(event.message);
        if (event.type === 'test-end') testsFinished += 1;
        write(event);
      } catch {
      }
    },
    onClose: (code) => (code === 0 || (code === 1 && testsFinished > 0 && !runErrors.length) ? { type: 'end', success: true } : undefined),
    preferredError: () => runErrors.join('\n'),
    onEvent: options.onEvent,
  };
}

export function runTestSuiteStreaming(options: RunTestSuiteOptions, res: ServerResponse): void {
  spawnPlaywrightNdjson(res, testSuiteRun(options));
}

export function runTestSuiteJob(options: RunTestSuiteOptions, signal?: AbortSignal) {
  return runPlaywrightJob(testSuiteRun(options), signal);
}
