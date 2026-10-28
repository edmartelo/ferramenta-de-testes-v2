import type { APIRequestContext, APIResponse, BrowserContext, Page, Request, Route } from '@playwright/test';

type PathRule = string | RegExp;

export interface LoginWrite {
  path: string;
  /** Resposta 2xx que já autentica: fecha a fase de login na hora. */
  endsLogin: (body: unknown, twoFactor: boolean) => boolean;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RESPONDER_PATH = /\/responder(\/|$)/i;
const API_CALL_TYPES = new Set(['xhr', 'fetch', 'eventsource']);
const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'manifest']);
const FAVICON_PATH = /\/favicon\.ico$/i;
const API_SEGMENT = /(^|\/)api(\/|$)/i;
const GENERIC_SECOND_LEVEL = new Set(['com', 'net', 'org', 'gov', 'edu', 'ind', 'art', 'blog', 'eco', 'app', 'co']);

const hasSessionToken = (body: unknown) => Boolean((body as { user?: { token?: unknown } } | null)?.user?.token);

// O painel declara o 2FA em `<meta name="gap">` (base64 de "1"); com ele, alguns painéis já devolvem token no login.
function declaresTwoFactor(html: string): boolean {
  const tag = html.match(/<meta[^>]*name=["']gap["'][^>]*>/i)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  try {
    return content !== undefined && atob(content) === '1';
  } catch {
    return false;
  }
}

// `loginAuthorizeIp`, `checkCodeAndAuthorizeIp`, `reset-gauth` e `edit` ficam de fora: gravam estado no servidor.
export const PAINEL_ENC_LOGIN_WRITES: LoginWrite[] = [
  { path: '/api/painel/login', endsLogin: (body, twoFactor) => !twoFactor && hasSessionToken(body) },
  { path: '/api/painel/checkCode', endsLogin: () => true },
];

// O monitor é hospedado no Firebase, mas não usa SDK do Firebase: tudo vai por axios pra esta API.
export const PROMO_MONITOR_API_HOST = 'api.monitor.exemplo.com.br';
const PROMO_MONITOR_API = '/backendPainelEnc2024/api';
export const PROMO_MONITOR_LOGIN_PATH = `${PROMO_MONITOR_API}/login`;

export function promoMonitorGuardOptions(apiHost = PROMO_MONITOR_API_HOST): ReadOnlyGuardOptions {
  return {
    apiHosts: [apiHost],
    loginWrites: [
      { path: PROMO_MONITOR_LOGIN_PATH, endsLogin: () => false },
      { path: `${PROMO_MONITOR_API}/checkCode`, endsLogin: () => true },
    ],
    apiReadPaths: [
      `${PROMO_MONITOR_API}/projects/monitor`,
      `${PROMO_MONITOR_API}/projects/monitor/encerrados`,
      `${PROMO_MONITOR_API}/google/access`,
      new RegExp(`^${PROMO_MONITOR_API}/recorrencias/[^/]+$`),
    ],
    loginDocumentPath: /^\/login\/?$/,
    documentPath: /^\/monitor\/?$/,
  };
}

export interface ReadOnlyGuardOptions {
  /** Únicos GETs não-estáticos liberados ao painel (e únicos xhr/fetch a qualquer host). Sem a lista, todo GET passa. */
  apiReadPaths?: PathRule[];
  documentPath?: RegExp;
  loginDocumentPath?: RegExp;
  loginWrites?: LoginWrite[];
  /** Hosts de API fora do domínio da página que também contam como painel. */
  apiHosts?: string[];
}

export interface ReadOnlyGuard {
  endLoginPhase(): void;
  /** Chamar depois de cada passo. */
  assertNoViolation(): void;
}

function registrableDomain(hostname: string): string {
  if (hostname === 'localhost' || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return hostname;
  const parts = hostname.split('.');
  const labels = parts.length > 2 && parts.at(-1)!.length === 2 && GENERIC_SECOND_LEVEL.has(parts.at(-2)!) ? 3 : 2;
  return parts.slice(-labels).join('.');
}

function decodedForms(value: string): string[] {
  const forms = [value];
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(forms.at(-1)!);
    } catch {
      break;
    }
    if (next === forms.at(-1)) break;
    forms.push(next);
  }
  return forms;
}

const hitsResponder = (url: URL) => [url.pathname, url.hash].some((part) => decodedForms(part).some((form) => RESPONDER_PATH.test(form)));

const matchesAny = (rules: PathRule[], path: string) => rules.some((rule) => (typeof rule === 'string' ? rule === path : rule.test(path)));

/** Trava somente leitura pra painel em produção: painel via `route.fetch` sem redirect; exige `serviceWorkers: 'block'`. */
export async function installReadOnlyGuard(context: BrowserContext, panelUrl: string, options: ReadOnlyGuardOptions = {}): Promise<ReadOnlyGuard> {
  const pageHost = new URL(panelUrl).hostname;
  const panelDomain = registrableDomain(pageHost);
  const apiHosts = new Set(options.apiHosts ?? []);
  const isPanelSite = (url: URL) => url.hostname === panelDomain || url.hostname.endsWith(`.${panelDomain}`) || apiHosts.has(url.hostname);
  const loginWrites = options.loginWrites ?? PAINEL_ENC_LOGIN_WRITES;
  const loginWritesLeft = new Map(loginWrites.map((write) => [write.path, 1]));
  const isListed = (path: string) => !options.apiReadPaths || matchesAny(options.apiReadPaths, path);
  let loginPhase = true;
  let twoFactor = false;
  const violations: string[] = [];

  function endLoginPhase() {
    loginPhase = false;
    loginWritesLeft.clear();
  }

  function block(route: Route, label: string, countsAsViolation = true) {
    if (countsAsViolation) violations.push(label);
    return route.abort();
  }

  const isRedirect = (response: APIResponse) => response.status() >= 300 && response.status() < 400;
  const isStaticAsset = (request: Request, url: URL) =>
    url.hostname === pageHost && !request.isNavigationRequest() && STATIC_TYPES.has(request.resourceType()) && !API_SEGMENT.test(url.pathname);

  // Painéis em subpasta mandam os chunks de JS com 301 para `/public/...`: segue um salto, só pra asset do mesmo host.
  function staticRedirectTarget(from: string, location: string | undefined): string | undefined {
    if (!location) return undefined;
    const target = new URL(location, from);
    return target.hostname === pageHost && !API_SEGMENT.test(target.pathname) && !hitsResponder(target) ? target.toString() : undefined;
  }

  async function forwardWithoutRedirect(
    route: Route,
    label: string,
    onResponse?: (response: APIResponse) => Promise<void>,
    followStaticRedirect = false,
  ) {
    let response = await route.fetch({ maxRedirects: 0 }).catch(() => null);
    if (!response) return route.abort();
    const staticTarget = followStaticRedirect && isRedirect(response) ? staticRedirectTarget(route.request().url(), response.headers().location) : undefined;
    if (staticTarget) {
      response = await route.fetch({ url: staticTarget, maxRedirects: 0 }).catch(() => null);
      if (!response) return route.abort();
    }
    if (isRedirect(response)) {
      return block(route, `${label} (redirecionamento para ${response.headers().location ?? '?'})`);
    }
    await onResponse?.(response);
    return route.fulfill({ response });
  }

  /** `undefined` = leitura liberada, string = motivo do bloqueio. */
  function readBlock(request: Request, url: URL): string | undefined {
    const path = url.pathname;
    if (request.isNavigationRequest()) {
      const documentPath = loginPhase ? options.loginDocumentPath : options.documentPath;
      return isPanelSite(url) && documentPath && !documentPath.test(path) ? 'navegação fora da lista' : undefined;
    }
    const type = request.resourceType();
    if (API_CALL_TYPES.has(type) && !isListed(path)) return 'chamada fora da lista';
    if (!isPanelSite(url) || isListed(path)) return undefined;
    if (isStaticAsset(request, url) || (url.hostname === pageHost && FAVICON_PATH.test(path) && !API_SEGMENT.test(path))) return undefined;
    return 'pedido ao painel fora da lista';
  }

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const label = `${method} ${url.origin}${url.pathname}`;
    const panel = isPanelSite(url);

    if (hitsResponder(url)) return block(route, label);

    // Preflight de CORS de verdade o Playwright responde sozinho; OPTIONS que chega aqui veio do JS.
    if (method === 'OPTIONS') {
      const preflight = await request.headerValue('access-control-request-method');
      if (preflight && isListed(url.pathname)) return route.continue();
      return block(route, `${label} (OPTIONS)`, panel);
    }

    if (method === 'GET' || method === 'HEAD') {
      const reason = readBlock(request, url);
      if (reason) return block(route, `${label} (${reason})`, panel);
      const readLoginPage = loginPhase && panel && request.isNavigationRequest();
      const onLoginPage = readLoginPage ? async (response: APIResponse) => void (twoFactor = declaresTwoFactor(await response.text())) : undefined;
      if (panel) return forwardWithoutRedirect(route, label, onLoginPage, isStaticAsset(request, url));
      return route.continue();
    }

    const write = loginPhase && panel && method === 'POST' ? loginWrites.find((candidate) => candidate.path === url.pathname) : undefined;
    const left = write ? loginWritesLeft.get(write.path) ?? 0 : 0;
    if (write && left > 0) {
      loginWritesLeft.set(write.path, left - 1);
      return forwardWithoutRedirect(route, label, async (response) => {
        if (response.ok() && write.endsLogin(await response.json().catch(() => null), twoFactor)) endLoginPhase();
      });
    }
    return block(route, label, panel);
  });

  context.on('request', (request) => {
    if (!request.redirectedFrom()) return;
    const url = new URL(request.url());
    const unsafe = !SAFE_METHODS.has(request.method()) || hitsResponder(url);
    const reason = unsafe ? undefined : isPanelSite(url) && readBlock(request, url);
    if (unsafe || reason) violations.push(`redirecionamento ${request.method()} ${url.origin}${url.pathname}${reason ? ` (${reason})` : ''}`);
  });

  const flagServiceWorker = (worker: { url(): string }) => violations.push(`service worker ${worker.url()}`);
  context.serviceWorkers().forEach(flagServiceWorker);
  context.on('serviceworker', flagServiceWorker);

  await context.routeWebSocket(/.*/, (ws) => {
    if (isPanelSite(new URL(ws.url()))) violations.push(`WebSocket ${ws.url()}`);
    return ws.close();
  });

  const watchSpaNavigation = (page: Page) =>
    page.on('framenavigated', (frame) => {
      if (hitsResponder(new URL(frame.url()))) violations.push(`navegação ${frame.url()}`);
    });
  context.pages().forEach(watchSpaNavigation);
  context.on('page', watchSpaNavigation);

  return {
    endLoginPhase,
    assertNoViolation() {
      if (violations.length) {
        throw new Error(`Trava de somente leitura: ${violations.length} tentativa(s) bloqueada(s) — rodada interrompida. ${violations.join(', ')}`);
      }
    },
  };
}

/** Redirect que só troca o host dentro do mesmo domínio (ex.: apex → www), mantendo HTTPS e caminho. */
export function sameSiteRedirectTarget(from: string, location: string | undefined): string | undefined {
  if (!location) return undefined;
  const source = new URL(from);
  const target = new URL(location, from);
  const trimmed = (path: string) => path.replace(/\/+$/, '');
  const sameSite = target.protocol === 'https:' && registrableDomain(target.hostname) === registrableDomain(source.hostname);
  return sameSite && trimmed(target.pathname) === trimmed(source.pathname) && !hitsResponder(target) ? target.toString().replace(/\/+$/, '') : undefined;
}

// A trava aborta todo redirect; o link do Monitor pode vir sem `www` e o navegador só segue o 301.
export async function resolvePanelUrl(request: APIRequestContext, panelUrl: string): Promise<string> {
  let current = panelUrl;
  for (let hop = 0; hop < 3; hop++) {
    const response = await request.get(current, { maxRedirects: 0 }).catch(() => null);
    if (!response || response.status() < 300 || response.status() >= 400) break;
    const next = sameSiteRedirectTarget(current, response.headers().location);
    if (!next) break;
    current = next;
  }
  return current;
}
