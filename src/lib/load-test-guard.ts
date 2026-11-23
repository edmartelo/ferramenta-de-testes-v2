import type { EnvKey, PromotionConfig } from '../../promotions/types.ts';

/** Carga só em Dev (validar o plano) e Homolog (medir). Produção nunca: não existe caminho no código que aceite `production`. */
export const LOAD_ENVS = ['dev', 'staging'] as const;
export type LoadEnv = (typeof LOAD_ENVS)[number];

export const LOAD_LIMITS = {
  maxUsers: 50,
  /** Acima disto, só depois de uma rodada leve sem erros da mesma promoção, ambiente e cenário. */
  smokeUsers: 5,
  minDurationSec: 30,
  maxDurationSec: 600,
  defaultUsers: 5,
  defaultDurationSec: 60,
} as const;

export class LoadTargetError extends Error {}

export interface LoadTarget {
  env: LoadEnv;
  siteUrl: string;
  /** `null` quando a API não passa no guard ou o site não informa `endpoint_uri`: o plano roda só as páginas. */
  apiUrl: string | null;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Rótulo do host que marca ambiente de teste (`hmg.exemplo.com.br`, `api-staging.x.com`). */
const TEST_ENV_LABEL = /^(hmg|hml|homolog|homologacao|staging|stg|dev|develop|test|teste|qa|sandbox|preview)\d*$/;

export function isLoadEnv(value: unknown): value is LoadEnv {
  return (LOAD_ENVS as readonly unknown[]).includes(value);
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
}

function hasTestEnvLabel(hostname: string): boolean {
  return hostname.toLowerCase().split('.').some((label) => label.split('-').some((part) => TEST_ENV_LABEL.test(part)));
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Hosts de Produção de todas as promoções: homolog é um host só, compartilhado, então uma promoção não pode mirar a produção de outra. */
export function productionHosts(promotions: readonly Pick<PromotionConfig, 'environments'>[]): Set<string> {
  const hosts = new Set<string>();
  for (const { environments } of promotions) {
    for (const url of [environments.site.production, environments.adminPanel.production, environments.api?.production]) {
      const host = hostOf(url);
      if (host) hosts.add(host);
    }
  }
  return hosts;
}

function parseHttpUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LoadTargetError(`${what} inválida: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new LoadTargetError(`${what} precisa ser http ou https.`);
  if (url.username || url.password) throw new LoadTargetError(`${what} não pode levar usuário e senha.`);
  return url;
}

function assertSafeHost(url: URL, env: LoadEnv, blocked: Set<string>, what: string): void {
  const host = url.hostname.toLowerCase();
  if (blocked.has(host)) throw new LoadTargetError(`${what} (${host}) é o host de Produção de uma promoção: teste de carga nunca roda em Produção.`);
  if (env === 'dev' && !isLoopbackHost(host)) throw new LoadTargetError(`Em Dev o teste de carga só roda no servidor desta máquina (localhost), e ${what} aponta para ${host}.`);
  if (env === 'staging' && !isLoopbackHost(host) && !hasTestEnvLabel(host)) {
    throw new LoadTargetError(`${what} (${host}) não tem cara de homolog (hmg, homolog, staging, dev, qa...): por segurança o teste de carga não roda nele.`);
  }
}

/** Único ponto que decide para onde a carga vai; roda na prévia, no início e de novo antes de subir o container. */
export function resolveLoadTarget(input: { env: unknown; siteUrl: string | undefined; apiUrl?: string | null; blockedHosts: Set<string> }): LoadTarget {
  if (input.env === 'production' || input.env === 'producao') throw new LoadTargetError('Teste de carga nunca roda em Produção.');
  if (!isLoadEnv(input.env)) throw new LoadTargetError('Ambiente do teste de carga precisa ser Dev ou Homolog.');
  const env = input.env;
  if (!input.siteUrl) throw new LoadTargetError(`Cadastre a URL do site em ${env === 'dev' ? 'Dev' : 'Homolog'} antes do teste de carga.`);
  const site = parseHttpUrl(input.siteUrl, 'URL do site');
  assertSafeHost(site, env, input.blockedHosts, 'URL do site');

  let apiUrl: string | null = null;
  if (input.apiUrl) {
    const api = parseHttpUrl(input.apiUrl, 'URL da API');
    assertSafeHost(api, env, input.blockedHosts, 'URL da API');
    // Em Homolog a API precisa estar no mesmo host do site: outro host poderia ser a API de Produção.
    if (env === 'dev' || api.hostname.toLowerCase() === site.hostname.toLowerCase()) apiUrl = api.href;
  }
  return { env, siteUrl: site.href, apiUrl };
}

export interface LoadSize {
  users: number;
  durationSec: number;
  rampUpSec: number;
}

/** Limites fixos no código; `hasCleanSmoke` libera mais de `smokeUsers` usuários. */
export function validateLoadSize(users: unknown, durationSec: unknown, hasCleanSmoke: boolean): LoadSize {
  const u = Number(users);
  const d = Number(durationSec);
  if (!Number.isInteger(u) || u < 1 || u > LOAD_LIMITS.maxUsers) throw new LoadTargetError(`Usuários precisa ser de 1 a ${LOAD_LIMITS.maxUsers}.`);
  if (!Number.isInteger(d) || d < LOAD_LIMITS.minDurationSec || d > LOAD_LIMITS.maxDurationSec) {
    throw new LoadTargetError(`Duração precisa ser de ${LOAD_LIMITS.minDurationSec} a ${LOAD_LIMITS.maxDurationSec} segundos.`);
  }
  if (u > LOAD_LIMITS.smokeUsers && !hasCleanSmoke) {
    throw new LoadTargetError(`Rode antes uma rodada leve (até ${LOAD_LIMITS.smokeUsers} usuários) sem erros neste ambiente e cenário.`);
  }
  return { users: u, durationSec: d, rampUpSec: Math.max(1, Math.min(u, Math.floor(d / 3))) };
}

export interface LoadConfirmation {
  siteUrl: string;
  apiUrl: string | null;
  users: number;
  durationSec: number;
}

/** A pessoa confirma o que viu na tela; se o servidor calcular outra coisa, nada roda. */
export function assertConfirmed(confirm: unknown, expected: LoadConfirmation): void {
  const c = confirm as Partial<LoadConfirmation> | null | undefined;
  if (!c || c.siteUrl !== expected.siteUrl || (c.apiUrl ?? null) !== expected.apiUrl || c.users !== expected.users || c.durationSec !== expected.durationSec) {
    throw new LoadTargetError('A confirmação não bate com o alvo e a carga calculados: abra a prévia de novo antes de rodar.');
  }
}

export function envLabel(env: EnvKey): string {
  return env === 'dev' ? 'Dev' : env === 'staging' ? 'Homolog' : 'Produção';
}
