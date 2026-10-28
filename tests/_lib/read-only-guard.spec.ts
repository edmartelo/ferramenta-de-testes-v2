import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promoMonitorGuardOptions, installReadOnlyGuard, sameSiteRedirectTarget } from '../../src/lib/read-only-guard';

let server: Server;
let origin: string;
const received: string[] = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith('/old/')) {
      res.writeHead(301, { Location: req.url.endsWith('api.js') ? '/api/painel/edit' : `/public/${req.url.slice('/old/'.length)}` });
      return res.end();
    }
    if (req.url?.endsWith('?redirect')) {
      const target = req.url.startsWith('/go') ? '/x/atendimentos/responder/1' : req.url.startsWith('/x/') ? '/x/logout' : '/api/painel/edit';
      res.writeHead(307, { Location: target, 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }
    const html = req.url === '/' || req.url?.startsWith('/x/') || req.url?.startsWith('/login') || req.url?.startsWith('/monitor');
    const type = req.url?.endsWith('.js') ? 'text/javascript' : req.url === '/logo.png' ? 'image/png' : html ? 'text/html' : 'application/json';
    res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    res.end(type === 'text/html' ? '<html><body>painel</body></html>' : type === 'application/json' ? '{}' : '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test.beforeEach(() => {
  received.length = 0;
});

test.use({ serviceWorkers: 'block' });

async function send(page: import('@playwright/test').Page, method: string, path: string): Promise<boolean> {
  return page.evaluate(
    ({ method, path }) => fetch(path, { method, body: method === 'GET' ? undefined : '{}' }).then(() => true, () => false),
    { method, path },
  );
}

test('login: só POST login e checkCode passam, uma vez cada', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin, { apiReadPaths: ['/api/painel/atendimentos'] });
  await page.goto(origin);

  expect(await send(page, 'POST', '/api/painel/login')).toBe(true);
  expect(await send(page, 'POST', '/api/painel/checkCode')).toBe(true);
  expect(await send(page, 'POST', '/api/painel/login')).toBe(false);
  expect(await send(page, 'POST', '/api/painel/loginAuthorizeIp')).toBe(false);

  expect(received.filter((r) => r.startsWith('POST'))).toEqual(['POST /api/painel/login', 'POST /api/painel/checkCode']);
  expect(() => guard.assertNoViolation()).toThrow(/2 tentativa/);
});

test('depois do login: nenhuma escrita, leitura só da lista, nada de /responder', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin, { apiReadPaths: ['/api/painel/atendimentos'] });
  await page.goto(origin);
  guard.endLoginPhase();

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    expect(await send(page, method, '/api/painel/login')).toBe(false);
    expect(await send(page, method, '/api/painel/atendimentos/1')).toBe(false);
  }
  expect(await send(page, 'GET', '/api/painel/atendimentos')).toBe(true);
  expect(await send(page, 'GET', '/api/painel/logout')).toBe(false);
  expect(await send(page, 'GET', '/x/atendimentos/responder/1')).toBe(false);

  expect(received).toEqual(['GET /', 'GET /api/painel/atendimentos']);
  expect(() => guard.assertNoViolation()).toThrow(/rodada interrompida/);
});

test('login redirecionado não reenvia o POST pra outra rota', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin);
  await page.goto(origin);

  expect(await send(page, 'POST', '/api/painel/login?redirect')).toBe(false);

  expect(received).toEqual(['GET /', 'POST /api/painel/login?redirect']);
  expect(() => guard.assertNoViolation()).toThrow(/redirecionamento para \/api\/painel\/edit/);
});

test('depois do login, fetch fora da lista é barrado mesmo fora de /api/', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin, { apiReadPaths: ['/api/painel/atendimentos'] });
  await page.goto(origin);
  guard.endLoginPhase();

  expect(await send(page, 'GET', '/painel/export')).toBe(false);

  expect(received).toEqual(['GET /']);
  expect(() => guard.assertNoViolation()).toThrow(/chamada fora da lista/);
});

test('navegação de documento redirecionada pra /responder vira violação', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin);
  await page.goto(`${origin}/go?redirect`).catch(() => {});

  expect(() => guard.assertNoViolation()).toThrow(/responder/);
});

test('API em outro subdomínio: imagem e EventSource fora da lista também são barrados', async ({ page, context }) => {
  const port = new URL(origin).port;
  const panel = `http://localhost:${port}`;
  const api = `http://api.localhost:${port}`;
  const guard = await installReadOnlyGuard(context, `${panel}/x`, { apiReadPaths: ['/api/painel/atendimentos'] });
  await page.goto(panel);
  guard.endLoginPhase();

  await page.evaluate((api) => new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = resolve;
    img.src = `${api}/api/painel/marcar-lido`;
  }), api);
  await page.evaluate(() => new Promise((resolve) => {
    const source = new EventSource('/api/painel/stream');
    source.onerror = () => { source.close(); resolve(null); };
  }));

  expect(received).toEqual(['GET /']);
  expect(() => guard.assertNoViolation()).toThrow(/marcar-lido.*stream/);
});

test('depois do login, navegação só pro caminho liberado', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin, { documentPath: /\/atendimentos\/?$/ });
  await page.goto(origin);
  guard.endLoginPhase();

  await page.goto(`${origin}/x/atendimentos`);
  guard.assertNoViolation();
  await page.goto(`${origin}/x/logout`).catch(() => {});

  expect(received).toEqual(['GET /', 'GET /x/atendimentos']);
  expect(() => guard.assertNoViolation()).toThrow(/navegação fora da lista/);
});

test('escrita feita por Web Worker também é barrada', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin);
  await page.goto(origin);
  guard.endLoginPhase();

  await page.evaluate((origin) => new Promise((resolve) => {
    const code = `fetch('${origin}/api/painel/edit', { method: 'POST', body: '{}' }).then(() => postMessage(1), () => postMessage(0))`;
    const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    worker.onmessage = resolve;
  }), origin);

  expect(received).toEqual(['GET /']);
  expect(() => guard.assertNoViolation()).toThrow(/POST .*\/api\/painel\/edit/);
});

test('navegação interna do SPA para /responder e WebSocket viram violação', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin);
  await page.goto(origin);
  guard.endLoginPhase();
  guard.assertNoViolation();

  await page.evaluate(() => history.pushState({}, '', '/x/atendimentos/responder/1'));
  await page.evaluate((wsUrl) => new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    ws.onclose = resolve;
    ws.onerror = resolve;
  }), origin.replace('http', 'ws'));

  expect(() => guard.assertNoViolation()).toThrow(/navegação .*responder.*WebSocket/);
  expect(received).toEqual(['GET /']);
});

function loadImage(page: import('@playwright/test').Page, src: string) {
  return page.evaluate((src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = resolve;
    img.src = src;
  }), src);
}

function loadScript(page: import('@playwright/test').Page, src: string) {
  return page.evaluate((src) => new Promise<boolean>((resolve) => {
    const script = document.createElement('script');
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    script.src = src;
    document.head.append(script);
  }), src);
}

test('script do mesmo host redirecionado é buscado num salto; redirect pra /api/ é barrado', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin, { apiReadPaths: ['/api/painel/atendimentos'] });
  await page.goto(origin);

  expect(await loadScript(page, '/old/chunk.js')).toBe(true);
  expect(await loadScript(page, '/old/api.js')).toBe(false);

  expect(received).toEqual(['GET /', 'GET /old/chunk.js', 'GET /public/chunk.js', 'GET /old/api.js']);
  expect(() => guard.assertNoViolation()).toThrow(/1 tentativa.*\/old\/api\.js/);
});

test('OPTIONS que não é preflight é barrado, antes e depois do login', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin, { apiReadPaths: ['/api/painel/atendimentos'] });
  await page.goto(origin);

  expect(await send(page, 'OPTIONS', '/api/painel/edit')).toBe(false);
  guard.endLoginPhase();
  expect(await send(page, 'OPTIONS', '/api/painel/atendimentos')).toBe(false);

  expect(received).toEqual(['GET /']);
  expect(() => guard.assertNoViolation()).toThrow(/2 tentativa.*OPTIONS/);
});

test('imagem e prefetch para /api/ do próprio host fora da lista são barrados; asset estático passa', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin, { apiReadPaths: ['/api/painel/atendimentos'] });
  await page.goto(origin);
  guard.endLoginPhase();

  await loadImage(page, '/logo.png');
  await loadImage(page, '/api/painel/moderacao/cupom/limpar');
  const prefetchFailed = page.waitForEvent('requestfailed', (r) => r.url().endsWith('/api/painel/export'));
  await page.evaluate(() => {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = '/api/painel/export';
    document.head.append(link);
  });
  await prefetchFailed;

  expect(received).toEqual(['GET /', 'GET /logo.png']);
  expect(() => guard.assertNoViolation()).toThrow(/limpar \(pedido ao painel fora da lista\).*export \(pedido ao painel fora da lista\)/);
});

test('durante o login, GET fora da lista e navegação fora da tela de login são barrados', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin, {
    apiReadPaths: ['/api/painel/atendimentos'],
    loginDocumentPath: /\/login\/?$/,
  });
  await page.goto(`${origin}/login`);

  await loadImage(page, '/logo.png');
  expect(await send(page, 'GET', '/api/painel/logout')).toBe(false);
  await page.goto(`${origin}/x/home`).catch(() => {});

  expect(received).toEqual(['GET /login', 'GET /logo.png']);
  expect(() => guard.assertNoViolation()).toThrow(/logout \(chamada fora da lista\).*\/x\/home \(navegação fora da lista\)/);
});

test('login sem 2FA (resposta com token) fecha a fase de login na própria trava; com 2FA declarado, checkCode passa', async ({ page, context }) => {
  const tokenServer = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    const html = req.url === '/' || req.url === '/2fa';
    res.writeHead(200, { 'Content-Type': html ? 'text/html' : 'application/json' });
    const meta = req.url === '/2fa' ? '<meta content="MQ==" name="gap">' : '';
    res.end(html ? `<html><head>${meta}</head></html>` : JSON.stringify({ user: { token: 'abc' } }));
  });
  await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
  const tokenOrigin = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}`;
  try {
    const guard = await installReadOnlyGuard(context, tokenOrigin, { apiReadPaths: [] });
    await page.goto(tokenOrigin);

    expect(await send(page, 'POST', '/api/painel/login')).toBe(true);
    expect(await send(page, 'POST', '/api/painel/checkCode')).toBe(false);

    expect(received).toEqual(['GET /', 'POST /api/painel/login']);
    expect(() => guard.assertNoViolation()).toThrow(/1 tentativa.*checkCode/);

    const twoFactorContext = await page.context().browser()!.newContext({ serviceWorkers: 'block' });
    const twoFactorGuard = await installReadOnlyGuard(twoFactorContext, tokenOrigin, { apiReadPaths: [] });
    const twoFactorPage = await twoFactorContext.newPage();
    await twoFactorPage.goto(`${tokenOrigin}/2fa`);
    received.length = 0;

    expect(await send(twoFactorPage, 'POST', '/api/painel/login')).toBe(true);
    expect(await send(twoFactorPage, 'POST', '/api/painel/checkCode')).toBe(true);
    expect(await send(twoFactorPage, 'POST', '/api/painel/checkCode')).toBe(false);

    expect(received).toEqual(['POST /api/painel/login', 'POST /api/painel/checkCode']);
    expect(() => twoFactorGuard.assertNoViolation()).toThrow(/1 tentativa/);
    await twoFactorContext.close();
  } finally {
    await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
  }
});

test('depois do login, navegação redirecionada pra fora do caminho liberado é barrada', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin, { documentPath: /\/atendimentos\/?$/ });
  await page.goto(origin);
  guard.endLoginPhase();

  await page.goto(`${origin}/x/atendimentos?redirect`).catch(() => {});

  expect(received).toEqual(['GET /', 'GET /x/atendimentos?redirect']);
  expect(() => guard.assertNoViolation()).toThrow(/redirecionamento para \/x\/logout/);
});

test('/responder com percent-encoding ou em rota de hash vira violação', async ({ page, context }) => {
  const guard = await installReadOnlyGuard(context, origin);
  await page.goto(origin);
  guard.endLoginPhase();

  expect(await send(page, 'GET', '/x/atendimentos/respond%65r/1')).toBe(false);
  expect(await send(page, 'GET', '/x/atendimentos%2Fresponder')).toBe(false);
  expect(await send(page, 'GET', '/x/atendimentos%252Fresponder%252F1')).toBe(false);
  await page.evaluate(() => { location.hash = '/atendimentos/responder/1'; });

  expect(received).toEqual(['GET /']);
  expect(() => guard.assertNoViolation()).toThrow(/4 tentativa.*navegação .*#\/atendimentos\/responder\/1/);
});

test('service worker registrado vira violação', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    const guard = await installReadOnlyGuard(context, origin);
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(() => navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready));

    await expect.poll(() => { try { guard.assertNoViolation(); return ''; } catch (error) { return (error as Error).message; } }).toMatch(/service worker .*\/sw\.js/);
  } finally {
    await context.close();
  }
});

test('monitor de promoções: API em outro host, login/checkCode uma vez, leitura só das rotas do monitor', async ({ page, context }) => {
  const api = `http://localhost:${new URL(origin).port}/backendPainelEnc2024/api`;
  const guard = await installReadOnlyGuard(context, origin, promoMonitorGuardOptions('localhost'));
  await page.goto(`${origin}/login`);

  expect(await send(page, 'POST', `${api}/login`)).toBe(true);
  expect(await send(page, 'GET', `${api}/users/profiles`)).toBe(false);
  expect(await send(page, 'POST', `${api}/checkCode`)).toBe(true);
  expect(await send(page, 'POST', `${api}/login`)).toBe(false);
  expect(await send(page, 'PUT', `${api}/projects/status/1`)).toBe(false);
  expect(await send(page, 'GET', `${api}/projects/monitor`)).toBe(true);
  expect(await send(page, 'GET', `${api}/recorrencias/42`)).toBe(true);
  expect(await send(page, 'GET', `${api}/recorrencias/42/apagar`)).toBe(false);
  await page.goto(`${origin}/monitor`);
  await page.goto(`${origin}/x/projetos`).catch(() => {});

  expect(received).toEqual([
    'GET /login',
    'POST /backendPainelEnc2024/api/login',
    'POST /backendPainelEnc2024/api/checkCode',
    'GET /backendPainelEnc2024/api/projects/monitor',
    'GET /backendPainelEnc2024/api/recorrencias/42',
    'GET /monitor',
  ]);
  expect(() => guard.assertNoViolation()).toThrow(/5 tentativa.*profiles.*login.*status\/1.*apagar.*projetos \(navegação fora da lista\)/);
});

test('link do painel: segue só troca de host no mesmo domínio, mesmo caminho e HTTPS', () => {
  const panel = 'https://promocaoexemplo.com.br/abc';
  expect(sameSiteRedirectTarget(panel, 'https://www.promocaoexemplo.com.br/abc')).toBe('https://www.promocaoexemplo.com.br/abc');
  expect(sameSiteRedirectTarget(panel, 'https://www.promocaoexemplo.com.br/abc/')).toBe('https://www.promocaoexemplo.com.br/abc');
  expect(sameSiteRedirectTarget(panel, 'https://www.promocaoexemplo.com.br/outro')).toBeUndefined();
  expect(sameSiteRedirectTarget(panel, 'http://www.promocaoexemplo.com.br/abc')).toBeUndefined();
  expect(sameSiteRedirectTarget(panel, 'https://evil.com.br/abc')).toBeUndefined();
  expect(sameSiteRedirectTarget(panel, undefined)).toBeUndefined();
});
