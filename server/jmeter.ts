import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { findLoadScenario, LOAD_SCENARIOS, type LoadScenario } from '../knowledge-base/load-scenarios.ts';
import { listPromotions } from '../promotions/index.ts';
import type { PromotionConfig } from '../promotions/types.ts';
import { db, jsonValue } from '../src/lib/db.ts';
import {
  assertConfirmed,
  isLoadEnv,
  isLoopbackHost,
  LOAD_LIMITS,
  LoadTargetError,
  productionHosts,
  resolveLoadTarget,
  validateLoadSize,
  type LoadConfirmation,
  type LoadEnv,
  type LoadTarget,
} from '../src/lib/load-test-guard.ts';
import { PROJECT_ROOT } from '../src/lib/paths.ts';
import { getAuthenticatedRole } from './auth.ts';
import { sendJson } from './http-utils.ts';
import { durationDetail, recordLog } from './logs.ts';
import { EXCLUSIVE_LOCK, JMETER_LOCK_KEY, releaseLock, tryAcquireLock, type JobLock } from './playwright-jobs.ts';

const IMAGE = 'alpine/jmeter:5.6.3';
const PLANS_DIR = join(PROJECT_ROOT, 'performance');
const RESULTS_DIR = join(PLANS_DIR, 'results');
const DOCKER_HOST = 'host.docker.internal';
const RESULTS_KEEP_MS = 30 * 24 * 60 * 60_000;
const PREFLIGHT_TIMEOUT_MS = 15_000;
/** Folga além da duração para o ramp-down e o relatório HTML. */
const RUN_GRACE_MS = 3 * 60_000;
/** Acima disto a rodada conta como "com erros" em vez de "ok". */
const OK_ERROR_PCT = 1;
const HISTORY_LIMIT = 20;
const RUN_ID = /^[0-9]{13}-[0-9a-f]{6}$/;
export const LOAD_MASTER_ONLY = 'Só usuários Master usam o teste de carga.';

const JMETER_LOCK: JobLock = {
  key: JMETER_LOCK_KEY,
  busyMessage: 'Já existe um teste de carga, uma rodada de testes ou Recorrências em andamento. Aguarde terminar.',
  conflictsWith: [EXCLUSIVE_LOCK.key, 'recurrences-refresh'],
};

export type LoadRunStatus = 'running' | 'ok' | 'errors' | 'failed' | 'canceled' | 'interrupted';

export interface LoadTransaction {
  label: string;
  samples: number;
  errors: number;
  errorPct: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  rps: number;
  /** Código HTTP (ou texto do erro de conexão) → quantidade. */
  codes: Record<string, number>;
}

export interface LoadSummary {
  total: LoadTransaction | null;
  transactions: LoadTransaction[];
}

export interface LoadProgress {
  samples: number;
  rps: number;
  avgMs: number;
  errors: number;
  errorPct: number;
  elapsedSec: number;
}

export interface LoadRun {
  id: string;
  promotionId: string;
  env: LoadEnv;
  scenario: string;
  siteUrl: string;
  apiUrl: string | null;
  users: number;
  rampUpSec: number;
  durationSec: number;
  machine: string;
  status: LoadRunStatus;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  summary: LoadSummary | null;
  /** O relatório HTML só existe na máquina que rodou. */
  reportAvailable: boolean;
  progress?: LoadProgress;
}

export interface LoadPreview extends LoadConfirmation {
  env: LoadEnv;
  scenario: string;
  rampUpSec: number;
  /** Por que a API ficou de fora (só as páginas rodam). */
  apiNote: string | null;
}

interface ActiveJob {
  run: LoadRun;
  container: string;
  canceled: boolean;
}

/** Em `globalThis`: o restart do Vite reimporta o módulo com o container ainda rodando. */
const state = globalThis as unknown as { __jmeterJob?: ActiveJob };

const machineName = hostname();

function newRunId(): string {
  return `${Date.now()}-${randomBytes(3).toString('hex')}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `endpoint_uri` do `index.html` do template padrão; placeholder não substituído conta como ausente. */
function apiFromHtml(html: string): string | undefined {
  const match = /<meta\s+name=["']endpoint_uri["']\s+content=["']([^"']*)["']/i.exec(html);
  const value = match?.[1]?.trim();
  return value && !value.startsWith('%') && !value.startsWith('<%') ? value : undefined;
}

const MAX_PREFLIGHT_REDIRECTS = 3;

/**
 * Segue redirecionamento só no mesmo host (ex.: barra no fim da URL cadastrada) e cada salto passa pelo guard;
 * a carga vai para a URL final, então o plano nunca precisa seguir redirecionamento.
 */
async function preflight(siteUrl: string, env: LoadEnv, blocked: Set<string>): Promise<{ finalUrl: string; html: string }> {
  let current = siteUrl;
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS), headers: { 'User-Agent': 'ferramenta-de-testes-jmeter' } });
    } catch (error) {
      throw new LoadTargetError(`O site não respondeu (${errorText(error)}). Em Dev, suba o projeto local antes.`);
    }
    if (response.status < 300 || response.status >= 400) {
      if (!response.ok) throw new LoadTargetError(`O site respondeu HTTP ${response.status}.`);
      return { finalUrl: current, html: await response.text() };
    }
    const location = response.headers.get('location');
    if (!location) throw new LoadTargetError(`O site respondeu HTTP ${response.status} sem destino.`);
    const next = new URL(location, current);
    if (next.hostname.toLowerCase() !== new URL(siteUrl).hostname.toLowerCase()) {
      throw new LoadTargetError(`O site redireciona para outro host (${next.host}): o teste de carga só roda no host cadastrado.`);
    }
    if (hop + 1 >= MAX_PREFLIGHT_REDIRECTS) throw new LoadTargetError('O site redireciona demais: confira a URL cadastrada.');
    current = resolveLoadTarget({ env, siteUrl: next.href, blockedHosts: blocked }).siteUrl;
  }
}

async function blockedHosts(): Promise<Set<string>> {
  return productionHosts(await listPromotions());
}

async function hasCleanSmoke(promotionId: string, env: LoadEnv, scenario: string): Promise<boolean> {
  const [rows] = await (await db()).query<RowDataPacket[]>(
    "SELECT 1 FROM load_test_runs WHERE promotion_id = ? AND env = ? AND scenario = ? AND status = 'ok' AND users <= ? LIMIT 1",
    [promotionId, env, scenario, LOAD_LIMITS.smokeUsers],
  );
  return rows.length > 0;
}

async function resolveTarget(promotion: PromotionConfig, env: unknown): Promise<{ target: LoadTarget; apiNote: string | null }> {
  const blocked = await blockedHosts();
  const siteUrl = isLoadEnv(env) ? promotion.environments.site[env] : undefined;
  const site = resolveLoadTarget({ env, siteUrl, blockedHosts: blocked });
  const { finalUrl, html } = await preflight(site.siteUrl, site.env, blocked);
  const registeredApi = isLoadEnv(env) ? promotion.environments.api?.[env]?.trim().replace(/\/api\/?$/, '') : undefined;
  const declaredApi = registeredApi || apiFromHtml(html);
  const target = resolveLoadTarget({ env, siteUrl: finalUrl, apiUrl: declaredApi, blockedHosts: blocked });
  let apiNote: string | null = null;
  if (!declaredApi) apiNote = 'Sem URL da API: cadastre nos Dados de acesso ou publique o site com a meta endpoint_uri. Só a Home entra na carga.';
  else if (!target.apiUrl) apiNote = `A API (${new URL(declaredApi).host}) está em outro host que o site: por segurança só a Home entra na carga.`;
  return { target, apiNote };
}

export async function previewLoadTest(promotion: PromotionConfig, body: Record<string, unknown>): Promise<LoadPreview> {
  const scenario = findLoadScenario(body.scenario);
  if (!scenario) throw new LoadTargetError('Cenário de carga desconhecido.');
  const { target, apiNote } = await resolveTarget(promotion, body.env);
  const size = validateLoadSize(body.users, body.durationSec, await hasCleanSmoke(promotion.id, target.env, scenario.id));
  return { env: target.env, scenario: scenario.id, siteUrl: target.siteUrl, apiUrl: target.apiUrl, users: size.users, durationSec: size.durationSec, rampUpSec: size.rampUpSec, apiNote };
}

export type LoadStart = { started: true; runId: string } | { started: false; status: number; error: string };

export async function startLoadTest(promotion: PromotionConfig, body: Record<string, unknown>, userId: string | undefined): Promise<LoadStart> {
  const preview = await previewLoadTest(promotion, body);
  assertConfirmed(body.confirm, preview);
  const scenario = findLoadScenario(preview.scenario)!;
  if (!tryAcquireLock(JMETER_LOCK)) return { started: false, status: 409, error: JMETER_LOCK.busyMessage };
  const run: LoadRun = {
    id: newRunId(),
    promotionId: promotion.id,
    env: preview.env,
    scenario: scenario.id,
    siteUrl: preview.siteUrl,
    apiUrl: preview.apiUrl,
    users: preview.users,
    rampUpSec: preview.rampUpSec,
    durationSec: preview.durationSec,
    machine: machineName,
    status: 'running',
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    summary: null,
    reportAvailable: false,
  };
  try {
    await (await db()).query(
      'INSERT INTO load_test_runs (id, promotion_id, env, scenario, target_url, api_url, users, rampup_s, duration_s, user_id, machine, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [run.id, run.promotionId, run.env, run.scenario, run.siteUrl, run.apiUrl, run.users, run.rampUpSec, run.durationSec, userId ?? null, run.machine, run.status, run.startedAt],
    );
  } catch (error) {
    releaseLock(JMETER_LOCK);
    throw error;
  }
  const job: ActiveJob = { run, container: `jmeter-${run.id}`, canceled: false };
  state.__jmeterJob = job;
  void execute(job, promotion.name, scenario, userId).finally(() => {
    if (state.__jmeterJob === job) state.__jmeterJob = undefined;
    releaseLock(JMETER_LOCK);
  });
  return { started: true, runId: run.id };
}

export function cancelLoadTest(promotionId: string): boolean {
  const job = state.__jmeterJob;
  if (!job || job.run.promotionId !== promotionId) return false;
  job.canceled = true;
  stopContainer(job.container);
  return true;
}

function stopContainer(name: string): void {
  spawn('docker', ['stop', '--time', '5', name], { windowsHide: true }).on('error', () => {});
}

/** De dentro do container, `localhost` é o próprio container. */
function dockerUrl(value: string): URL {
  const url = new URL(value);
  if (isLoopbackHost(url.hostname)) url.hostname = DOCKER_HOST;
  return url;
}

function defaultPort(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function jmeterProperties(run: LoadRun): string[] {
  const site = dockerUrl(run.siteUrl);
  const props: Record<string, string> = {
    users: String(run.users),
    rampup: String(run.rampUpSec),
    duration: String(run.durationSec),
    siteProtocol: site.protocol.replace(':', ''),
    siteHost: site.hostname,
    sitePort: defaultPort(site),
    sitePath: site.pathname || '/',
    // JS e CSS só do host do site: recurso de outro host não entra na carga.
    embeddedRe: `https?://${escapeRegExp(site.hostname)}(:\\d+)?/.*`,
    apiEnabled: String(Boolean(run.apiUrl)),
    'summariser.interval': '10',
    'jmeter.save.saveservice.subresults': 'false',
  };
  if (run.apiUrl) {
    const api = dockerUrl(run.apiUrl);
    Object.assign(props, { apiProtocol: api.protocol.replace(':', ''), apiHost: api.hostname, apiPort: defaultPort(api), apiPath: api.pathname.replace(/\/+$/, '') });
  }
  return Object.entries(props).map(([key, value]) => `-J${key}=${value}`);
}

const SUMMARY_LINE = /^summary =\s+(\d+) in ([\d:]+) =\s+([\d.]+)\/s Avg:\s+(\d+).*?Err:\s+(\d+) \(([\d.]+)%\)/;

function parseSummaryLine(line: string): LoadProgress | undefined {
  const match = SUMMARY_LINE.exec(line.trim());
  if (!match) return undefined;
  const [h = 0, m = 0, s = 0] = match[2]!.split(':').map(Number);
  return { samples: Number(match[1]), elapsedSec: h * 3600 + m * 60 + s, rps: Number(match[3]), avgMs: Number(match[4]), errors: Number(match[5]), errorPct: Number(match[6]) };
}

async function execute(job: ActiveJob, promotionName: string, scenario: LoadScenario, userId: string | undefined): Promise<void> {
  const { run } = job;
  const outDir = join(RESULTS_DIR, run.id);
  let output = '';
  try {
    // Última conferência antes de subir o container: a lista de hosts de Produção pode ter mudado.
    resolveLoadTarget({ env: run.env, siteUrl: run.siteUrl, apiUrl: run.apiUrl, blockedHosts: await blockedHosts() });
    mkdirSync(outDir, { recursive: true });
    const args = [
      'run', '--rm', '--name', job.container,
      '-v', `${PLANS_DIR}:/plans:ro`,
      '-v', `${outDir}:/out`,
      IMAGE,
      '-n', '-t', `/plans/${scenario.plan}`,
      '-l', '/out/results.jtl', '-j', '/out/jmeter.log', '-e', '-o', '/out/report',
      ...jmeterProperties(run),
    ];
    const code = await new Promise<number | null>((resolveCode, reject) => {
      if (job.canceled) return resolveCode(null);
      const child = spawn('docker', args, { windowsHide: true });
      const deadline = setTimeout(() => stopContainer(job.container), run.durationSec * 1000 + RUN_GRACE_MS);
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (text: string) => {
        output = (output + text).slice(-8000);
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const progress = parseSummaryLine(line);
          if (progress) run.progress = progress;
        }
      });
      child.stderr.on('data', (text: string) => {
        output = (output + text).slice(-8000);
      });
      child.on('error', (error) => {
        clearTimeout(deadline);
        reject(new Error(`Não foi possível rodar o Docker: ${error.message}`));
      });
      child.on('close', (exitCode) => {
        clearTimeout(deadline);
        resolveCode(exitCode);
      });
    });
    if (job.canceled) {
      run.status = 'canceled';
      run.error = 'Cancelado.';
    } else if (code !== 0) {
      run.status = 'failed';
      run.error = jmeterFailure(output, code);
    } else {
      run.summary = readSummary(outDir);
      const errorPct = run.summary.total?.errorPct ?? 100;
      run.status = run.summary.total && errorPct <= OK_ERROR_PCT ? 'ok' : 'errors';
    }
  } catch (error) {
    run.status = job.canceled ? 'canceled' : 'failed';
    run.error = errorText(error);
  }
  run.finishedAt = Date.now();
  try {
    await (await db()).query('UPDATE load_test_runs SET status = ?, summary = ?, error = ?, finished_at = ? WHERE id = ?', [
      run.status, run.summary ? JSON.stringify(run.summary) : null, run.error, run.finishedAt, run.id,
    ]);
  } catch (error) {
    run.error = `${run.error ?? ''} Não salvou no banco: ${errorText(error)}`.trim();
  }
  const total = run.summary?.total;
  recordLog({
    source: 'jmeter',
    trigger: 'manual',
    userId,
    action: `Teste de carga (${scenario.label}, ${run.env === 'dev' ? 'Dev' : 'Homolog'}): ${promotionName}`,
    ok: run.status === 'ok',
    message: run.error ?? (run.status === 'ok' ? 'Rodada concluída sem erros.' : 'Rodada concluída com erros.'),
    details: {
      usuarios: run.users,
      duracao: durationDetail(run.startedAt),
      ...(total && { requisicoes: total.samples, erroPct: Number(total.errorPct.toFixed(2)), p95Ms: Math.round(total.p95Ms), reqPorSegundo: Number(total.rps.toFixed(2)) }),
    },
  });
}

function jmeterFailure(output: string, code: number | null): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const error = lines.find((line) => /error|exception|unable|cannot|not found/i.test(line) && !/^summary/.test(line));
  return error ? `${error.slice(0, 300)}` : `O JMeter encerrou com código ${code}.`;
}

interface StatisticsEntry {
  transaction: string;
  sampleCount: number;
  errorCount: number;
  errorPct: number;
  meanResTime: number;
  medianResTime: number;
  maxResTime: number;
  pct1ResTime: number;
  pct2ResTime: number;
  pct3ResTime: number;
  throughput: number;
}

/** `statistics.json` do relatório HTML (percentis 90/95/99 padrão) mais a contagem de códigos tirada do JTL. */
function readSummary(outDir: string): LoadSummary {
  const statsPath = join(outDir, 'report', 'statistics.json');
  if (!existsSync(statsPath)) return { total: null, transactions: [] };
  const stats = JSON.parse(readFileSync(statsPath, 'utf8')) as Record<string, StatisticsEntry>;
  const codes = countCodes(join(outDir, 'results.jtl'));
  const toTransaction = (entry: StatisticsEntry, label: string): LoadTransaction => ({
    label,
    samples: entry.sampleCount,
    errors: entry.errorCount,
    errorPct: entry.errorPct,
    meanMs: entry.meanResTime,
    p50Ms: entry.medianResTime,
    p90Ms: entry.pct1ResTime,
    p95Ms: entry.pct2ResTime,
    p99Ms: entry.pct3ResTime,
    maxMs: entry.maxResTime,
    rps: entry.throughput,
    codes: label === 'Total' ? sumCodes(codes) : codes.get(label) ?? {},
  });
  const transactions = Object.entries(stats).filter(([label]) => label !== 'Total').map(([label, entry]) => toTransaction(entry, label));
  return { total: stats.Total ? toTransaction(stats.Total, 'Total') : null, transactions };
}

function sumCodes(codes: Map<string, Record<string, number>>): Record<string, number> {
  const total: Record<string, number> = {};
  for (const perLabel of codes.values()) for (const [code, count] of Object.entries(perLabel)) total[code] = (total[code] ?? 0) + count;
  return total;
}

/** CSV do JMeter: campo entre aspas pode ter vírgula e quebra de linha (mensagem da assertion). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function countCodes(jtlPath: string): Map<string, Record<string, number>> {
  const result = new Map<string, Record<string, number>>();
  if (!existsSync(jtlPath)) return result;
  const [header, ...rows] = parseCsv(readFileSync(jtlPath, 'utf8'));
  const labelIndex = header?.indexOf('label') ?? -1;
  const codeIndex = header?.indexOf('responseCode') ?? -1;
  if (labelIndex < 0 || codeIndex < 0) return result;
  for (const row of rows) {
    const label = row[labelIndex];
    if (!label) continue;
    const code = (row[codeIndex] || 'sem resposta').slice(0, 60);
    const perLabel = result.get(label) ?? {};
    perLabel[code] = (perLabel[code] ?? 0) + 1;
    result.set(label, perLabel);
  }
  return result;
}

function rowToRun(row: RowDataPacket): LoadRun {
  const job = state.__jmeterJob;
  if (job && job.run.id === row.id) return { ...job.run };
  let status = row.status as LoadRunStatus;
  // Rodada "em andamento" desta máquina sem job vivo: o npm run dev caiu no meio.
  if (status === 'running' && row.machine === machineName) status = 'interrupted';
  return {
    id: row.id,
    promotionId: row.promotion_id,
    env: row.env,
    scenario: row.scenario,
    siteUrl: row.target_url,
    apiUrl: row.api_url ?? null,
    users: Number(row.users),
    rampUpSec: Number(row.rampup_s),
    durationSec: Number(row.duration_s),
    machine: row.machine,
    status,
    error: row.error ?? null,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    summary: row.summary ? jsonValue<LoadSummary>(row.summary) : null,
    reportAvailable: existsSync(join(RESULTS_DIR, row.id, 'report', 'index.html')),
  };
}

export interface LoadTestStatus {
  scenarios: readonly LoadScenario[];
  limits: typeof LOAD_LIMITS;
  /** Ambientes com URL do site cadastrada. */
  envs: LoadEnv[];
  /** `env:cenário` que já tiveram rodada leve sem erros. */
  smokeDone: string[];
  running: LoadRun | null;
  /** Outra promoção ocupando o JMeter desta máquina. */
  busyElsewhere: boolean;
  history: LoadRun[];
}

export async function loadTestStatus(promotion: PromotionConfig): Promise<LoadTestStatus> {
  const pool = await db();
  const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM load_test_runs WHERE promotion_id = ? ORDER BY started_at DESC LIMIT ?', [promotion.id, HISTORY_LIMIT]);
  const [smoke] = await pool.query<RowDataPacket[]>(
    "SELECT DISTINCT env, scenario FROM load_test_runs WHERE promotion_id = ? AND status = 'ok' AND users <= ?",
    [promotion.id, LOAD_LIMITS.smokeUsers],
  );
  const active = state.__jmeterJob;
  return {
    scenarios: LOAD_SCENARIOS,
    limits: LOAD_LIMITS,
    envs: (['dev', 'staging'] as const).filter((env) => Boolean(promotion.environments.site[env])),
    smokeDone: smoke.map((row) => `${row.env}:${row.scenario}`),
    running: active?.run.promotionId === promotion.id ? { ...active.run } : null,
    busyElsewhere: Boolean(active && active.run.promotionId !== promotion.id),
    history: rows.map(rowToRun),
  };
}

export interface LoadOverviewPromotion {
  id: string;
  name: string;
  client: string;
  last: LoadRun | null;
}

async function loadOverview(): Promise<LoadOverviewPromotion[]> {
  const testing = (await listPromotions()).filter((promotion) => (promotion.stage ?? 'testing') === 'testing');
  if (!testing.length) return [];
  const [rows] = await (await db()).query<RowDataPacket[]>(
    `SELECT r.* FROM load_test_runs r
      JOIN (SELECT promotion_id, MAX(started_at) AS started_at FROM load_test_runs WHERE promotion_id IN (?) GROUP BY promotion_id) last
      ON last.promotion_id = r.promotion_id AND last.started_at = r.started_at`,
    [testing.map((promotion) => promotion.id)],
  );
  const lastById = new Map(rows.map((row) => [row.promotion_id as string, rowToRun(row)]));
  return testing.map(({ id, name, client }) => ({ id, name, client, last: lastById.get(id) ?? null }));
}

export async function deleteLoadTestRuns(promotionId: string): Promise<void> {
  await (await db()).query('DELETE FROM load_test_runs WHERE promotion_id = ?', [promotionId]);
}

/** Resultados locais com mais de 30 dias (a linha no banco continua). */
export function purgeOldLoadResults(): void {
  if (!existsSync(RESULTS_DIR)) return;
  const active = state.__jmeterJob?.run.id;
  for (const entry of readdirSync(RESULTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === active) continue;
    const path = join(RESULTS_DIR, entry.name);
    if (Date.now() - statSync(path).mtimeMs > RESULTS_KEEP_MS) rmSync(path, { recursive: true, force: true });
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

/** Só arquivos dentro de `performance/results/<runId>/report/`. */
function serveReport(res: ServerResponse, runId: string, rest: string[]): void {
  const root = resolve(RESULTS_DIR, runId, 'report');
  const file = resolve(root, ...(rest.length ? rest : ['index.html']).map(decodeURIComponent));
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
    sendJson(res, 404, { error: 'Relatório não encontrado nesta máquina.' });
    return;
  }
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
}

/** `/api/load-tests` (visão geral) e `/api/load-tests/<runId>/report/...` (relatório HTML do JMeter). */
export async function handleLoadTestsRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[1] !== 'load-tests' || req.method !== 'GET') return false;
  if (getAuthenticatedRole(req) !== 'master') return sendJson(res, 403, { error: LOAD_MASTER_ONLY });
  if (parts.length === 2) return sendJson(res, 200, await loadOverview());
  const runId = parts[2] ?? '';
  if (!RUN_ID.test(runId) || parts[3] !== 'report') return sendJson(res, 404, { error: 'Rota de API desconhecida.' });
  serveReport(res, runId, parts.slice(4));
  return true;
}
