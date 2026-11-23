import type { PromotionConfig } from '../../promotions/types';
import { findLoadScenario, LOAD_SCENARIOS } from '../../knowledge-base/load-scenarios';
import { assertConfirmed, LOAD_LIMITS, productionHosts, resolveLoadTarget, validateLoadSize, type LoadEnv } from '../lib/load-test-guard';
import type { LoadOverviewPromotion, LoadPreview, LoadRun, LoadSummary, LoadTestStatus, LoadTransaction } from '../api';

/** JMeter da demo: o guard real decide o alvo, mas nenhuma requisição sai do navegador; métricas são fictícias. */

const DEMO_MACHINE = 'demonstração';
/** A rodada simulada dura uma fração da duração pedida, para o visitante ver o fim. */
const SPEEDUP = 10;
const MIN_REAL_MS = 8_000;
const MAX_REAL_MS = 20_000;

const STEPS = [
  { label: 'Home', baseMs: 420, api: false },
  { label: 'API regulamentos', baseMs: 160, api: true },
  { label: 'API ganhadores vale-brinde', baseMs: 230, api: true },
  { label: 'API ganhadores sorteio', baseMs: 210, api: true },
  { label: 'API dúvidas', baseMs: 140, api: true },
];

interface ActiveRun {
  run: LoadRun;
  realMs: number;
  errorRate: number;
}

const history = new Map<string, LoadRun[]>();
let active: ActiveRun | undefined;

function apiUrlFor(promotion: PromotionConfig, env: LoadEnv): string | undefined {
  const registered = promotion.environments.api?.[env];
  if (registered) return registered;
  const site = promotion.environments.site[env];
  return site ? new URL('/promo-api', site).href : undefined;
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function transaction(label: string, samples: number, errors: number, meanMs: number, durationSec: number): LoadTransaction {
  const codes: Record<string, number> = { '200': samples - errors };
  if (errors) codes['503'] = errors;
  return {
    label,
    samples,
    errors,
    errorPct: samples ? round((errors / samples) * 100, 2) : 0,
    meanMs: round(meanMs),
    p50Ms: round(meanMs * 0.85),
    p90Ms: round(meanMs * 1.6),
    p95Ms: round(meanMs * 1.9),
    p99Ms: round(meanMs * 2.8),
    maxMs: round(meanMs * 4.2),
    rps: round(samples / durationSec, 2),
    codes,
  };
}

function summarize(users: number, durationSec: number, withApi: boolean, errorRate: number, fraction = 1): LoadSummary {
  const elapsed = Math.max(1, durationSec * fraction);
  const load = 1 + users / 25;
  const transactions = STEPS.filter((step) => withApi || !step.api).map((step) => {
    const samples = Math.max(1, Math.round(users * elapsed * (step.api ? 0.18 : 0.3)));
    return transaction(step.label, samples, Math.round(samples * errorRate), step.baseMs * load, elapsed);
  });
  const samples = transactions.reduce((sum, t) => sum + t.samples, 0);
  const errors = transactions.reduce((sum, t) => sum + t.errors, 0);
  const meanMs = transactions.reduce((sum, t) => sum + t.meanMs * t.samples, 0) / samples;
  const total = transaction('Total', samples, errors, meanMs, elapsed);
  total.codes = transactions.reduce<Record<string, number>>((all, t) => {
    for (const [code, count] of Object.entries(t.codes)) all[code] = (all[code] ?? 0) + count;
    return all;
  }, {});
  return { total, transactions };
}

function pastRun(promotion: PromotionConfig, daysAgo: number, users: number, durationSec: number, errorRate: number): LoadRun {
  const startedAt = Date.now() - daysAgo * 24 * 60 * 60_000;
  const siteUrl = promotion.environments.site.staging ?? '';
  return {
    id: `demo-${promotion.id}-${daysAgo}`,
    promotionId: promotion.id,
    env: 'staging',
    scenario: LOAD_SCENARIOS[0].id,
    siteUrl,
    apiUrl: apiUrlFor(promotion, 'staging') ?? null,
    users,
    rampUpSec: Math.max(1, Math.min(users, Math.floor(durationSec / 3))),
    durationSec,
    machine: DEMO_MACHINE,
    status: errorRate > 0 ? 'errors' : 'ok',
    error: null,
    startedAt,
    finishedAt: startedAt + durationSec * 1000,
    summary: summarize(users, durationSec, true, errorRate),
    reportAvailable: false,
  };
}

function runsOf(promotion: PromotionConfig): LoadRun[] {
  let runs = history.get(promotion.id);
  if (!runs) {
    runs = promotion.id === 'verao-premiado' ? [pastRun(promotion, 1, 30, 120, 0.012), pastRun(promotion, 3, 5, 60, 0)] : [];
    history.set(promotion.id, runs);
  }
  return runs;
}

/** Atualiza o andamento pelo relógio e fecha a rodada quando o tempo simulado acaba. */
function tick(): void {
  if (!active) return;
  const { run, realMs, errorRate } = active;
  const fraction = Math.min(1, (Date.now() - run.startedAt) / realMs);
  const partial = summarize(run.users, run.durationSec, Boolean(run.apiUrl), errorRate, Math.max(fraction, 0.01));
  const total = partial.total!;
  run.progress = { samples: total.samples, rps: total.rps, avgMs: total.meanMs, errors: total.errors, errorPct: total.errorPct, elapsedSec: Math.round(run.durationSec * fraction) };
  if (fraction < 1) return;
  run.status = total.errors ? 'errors' : 'ok';
  run.finishedAt = Date.now();
  run.summary = summarize(run.users, run.durationSec, Boolean(run.apiUrl), errorRate);
  delete run.progress;
  active = undefined;
  history.get(run.promotionId)?.unshift(run);
}

export function demoLoadOverview(promotions: PromotionConfig[]): LoadOverviewPromotion[] {
  tick();
  return promotions
    .filter((promotion) => (promotion.stage ?? 'testing') === 'testing')
    .map((promotion) => {
      const running = active?.run.promotionId === promotion.id ? active.run : undefined;
      return { id: promotion.id, name: promotion.name, client: promotion.client, last: running ?? runsOf(promotion)[0] ?? null };
    });
}

export function demoLoadStatus(promotion: PromotionConfig): LoadTestStatus {
  tick();
  const runs = runsOf(promotion);
  return {
    scenarios: LOAD_SCENARIOS,
    limits: LOAD_LIMITS,
    envs: (['dev', 'staging'] as const).filter((env) => Boolean(promotion.environments.site[env])),
    smokeDone: [...new Set(runs.filter((run) => run.status === 'ok' && run.users <= LOAD_LIMITS.smokeUsers).map((run) => `${run.env}:${run.scenario}`))],
    running: active?.run.promotionId === promotion.id ? { ...active.run } : null,
    busyElsewhere: Boolean(active && active.run.promotionId !== promotion.id),
    history: active?.run.promotionId === promotion.id ? [{ ...active.run }, ...runs] : runs,
  };
}

export function demoLoadPreview(promotion: PromotionConfig, promotions: PromotionConfig[], body: Record<string, unknown>): LoadPreview {
  const scenario = findLoadScenario(body.scenario);
  if (!scenario) throw new Error('Cenário de carga desconhecido.');
  const blockedHosts = productionHosts(promotions);
  const env = body.env;
  const siteUrl = env === 'dev' || env === 'staging' ? promotion.environments.site[env] : undefined;
  const site = resolveLoadTarget({ env, siteUrl, blockedHosts });
  const target = resolveLoadTarget({ env, siteUrl: site.siteUrl, apiUrl: apiUrlFor(promotion, site.env), blockedHosts });
  const smoke = demoLoadStatus(promotion).smokeDone.includes(`${target.env}:${scenario.id}`);
  const size = validateLoadSize(body.users, body.durationSec, smoke);
  return { env: target.env, scenario: scenario.id, siteUrl: target.siteUrl, apiUrl: target.apiUrl, users: size.users, durationSec: size.durationSec, rampUpSec: size.rampUpSec, apiNote: null };
}

export function demoLoadStart(promotion: PromotionConfig, promotions: PromotionConfig[], body: Record<string, unknown>): { runId: string } {
  const preview = demoLoadPreview(promotion, promotions, body);
  assertConfirmed(body.confirm, preview);
  tick();
  if (active) throw new Error('Já existe um teste de carga em andamento. Aguarde terminar ou cancele.');
  const run: LoadRun = {
    id: `demo-${Date.now()}`,
    promotionId: promotion.id,
    env: preview.env,
    scenario: preview.scenario,
    siteUrl: preview.siteUrl,
    apiUrl: preview.apiUrl,
    users: preview.users,
    rampUpSec: preview.rampUpSec,
    durationSec: preview.durationSec,
    machine: DEMO_MACHINE,
    status: 'running',
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    summary: null,
    reportAvailable: false,
  };
  const realMs = Math.min(MAX_REAL_MS, Math.max(MIN_REAL_MS, (preview.durationSec * 1000) / SPEEDUP));
  active = { run, realMs, errorRate: preview.users > 20 ? 0.008 : 0 };
  return { runId: run.id };
}

export function demoLoadCancel(promotionId: string): void {
  if (!active || active.run.promotionId !== promotionId) throw new Error('Nenhum teste de carga desta promoção em andamento.');
  const { run } = active;
  run.status = 'canceled';
  run.finishedAt = Date.now();
  run.summary = summarize(run.users, run.durationSec, Boolean(run.apiUrl), active.errorRate, Math.min(1, (Date.now() - run.startedAt) / active.realMs));
  delete run.progress;
  active = undefined;
  history.get(promotionId)?.unshift(run);
}
