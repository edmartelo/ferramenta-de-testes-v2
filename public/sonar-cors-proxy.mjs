#!/usr/bin/env node
// Proxy local para a tela "Qualidade de código" da demo ler o SonarQube desta máquina.
// O SonarQube não responde CORS; este proxy repassa só leituras (GET /api/*) e só libera a origem da demo.
// Uso: node sonar-cors-proxy.mjs [--port=9002] [--target=http://127.0.0.1:9001]
// Também aceita as variáveis SONAR_PROXY_PORT e SONAR_PROXY_TARGET.
import http from 'node:http';
import https from 'node:https';

const DEMO_ORIGIN = 'https://ferramenta-de-testes-demo.vercel.app';
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const UPSTREAM_TIMEOUT_MS = 30_000;

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const port = Number(option('port') ?? process.env.SONAR_PROXY_PORT ?? 9002);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Porta inválida: ${port}`);

let target;
try {
  target = new URL(option('target') ?? process.env.SONAR_PROXY_TARGET ?? 'http://127.0.0.1:9001');
} catch {
  fail('Endereço do SonarQube inválido. Exemplo: --target=http://127.0.0.1:9001');
}
if (!['http:', 'https:'].includes(target.protocol) || !LOOPBACK_HOSTS.has(target.hostname)) {
  fail(`O SonarQube precisa estar nesta máquina (127.0.0.1 ou localhost); recusado: ${target.origin}`);
}

function allowedOrigin(origin) {
  return origin === DEMO_ORIGIN || LOCAL_ORIGIN.test(origin);
}

// Protege contra DNS rebinding: só atende quem chamou o proxy pelo endereço local.
function allowedHost(host) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function log(req, status) {
  console.log(`${new Date().toISOString()} ${req.method} ${(req.url ?? '').split('?')[0]} ${status}`);
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};

  if (!allowedHost(req.headers.host ?? '')) {
    log(req, 421);
    return send(res, 421, { errors: [{ msg: 'Host não permitido.' }] });
  }
  if (origin && !allowedOrigin(origin)) {
    log(req, 403);
    return send(res, 403, { errors: [{ msg: 'Origem não permitida.' }] });
  }

  if (req.method === 'OPTIONS') {
    if (req.headers['access-control-request-method'] !== 'GET') {
      log(req, 403);
      return send(res, 403, { errors: [{ msg: 'Só leituras (GET) são permitidas.' }] });
    }
    const headers = {
      ...cors,
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Authorization',
      'Access-Control-Max-Age': '600',
    };
    if (req.headers['access-control-request-private-network'] === 'true') headers['Access-Control-Allow-Private-Network'] = 'true';
    res.writeHead(204, headers);
    res.end();
    log(req, 204);
    return;
  }

  if (req.method !== 'GET') {
    log(req, 405);
    return send(res, 405, { errors: [{ msg: 'Só leituras (GET) são permitidas.' }] }, { ...cors, Allow: 'GET, OPTIONS' });
  }

  const path = req.url ?? '/';
  if (path === '/proxy-info') {
    log(req, 200);
    return send(res, 200, { target: target.origin }, cors);
  }
  const upstreamUrl = new URL(path, target);
  if (!path.startsWith('/api/') || upstreamUrl.origin !== target.origin || !upstreamUrl.pathname.startsWith('/api/')) {
    log(req, 404);
    return send(res, 404, { errors: [{ msg: 'Só a API do SonarQube (/api/*) passa por este proxy.' }] }, cors);
  }

  const upstreamHeaders = { Accept: 'application/json' };
  if (req.headers.authorization) upstreamHeaders.Authorization = req.headers.authorization;
  const client = target.protocol === 'https:' ? https : http;
  const upstream = client.request(upstreamUrl, { method: 'GET', headers: upstreamHeaders, timeout: UPSTREAM_TIMEOUT_MS }, (answer) => {
    const status = answer.statusCode ?? 502;
    res.writeHead(status, { ...cors, 'Content-Type': answer.headers['content-type'] ?? 'application/json', 'Cache-Control': 'no-store' });
    answer.pipe(res);
    log(req, status);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    log(req, 502);
    send(res, 502, { errors: [{ msg: `SonarQube fora do ar em ${target.origin}.` }] }, cors);
  });
  upstream.end();
});

server.on('error', (error) => fail(error.code === 'EADDRINUSE' ? `A porta ${port} já está em uso: rode com --port=OUTRA.` : error.message));
server.listen(port, '127.0.0.1', () => {
  console.log(`Proxy do SonarQube em http://127.0.0.1:${port} -> ${target.origin}`);
  console.log(`Origens liberadas: ${DEMO_ORIGIN}, http://localhost:* e http://127.0.0.1:*. Ctrl+C para parar.`);
});
