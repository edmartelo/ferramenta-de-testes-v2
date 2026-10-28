import { generateKeyPairSync, sign } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test, expect } from '@playwright/test';
import { parseAccountDelete, parseAccountUpdate, parseActivity, parseGoogleAuth, parseLogin, parseSignup, parseTotpDisable, parseTotpEnable } from '../../server/demo/accounts';
import { verifyGoogleIdToken, type GoogleJwk } from '../../server/demo/google';
import handleDemoRequest from '../../server/demo/api';
import { plannedStatuses, runFakeTests } from '../../src/demo/fake-runner';
import type { TestRunEvent } from '../../server/test-runner';
import { generateTotpCode, generateTotpSecret } from '../../src/lib/totp';

const ROOT = join(import.meta.dirname, '..', '..');
const SQL_PAYLOADS = ["' OR 1=1 --", '"; DROP TABLE demo_accounts; --', "admin'--@x.com", "x@x.com' UNION SELECT * FROM users --"];

const validSignup = { name: 'Ana Exemplo', email: 'ana@exemplo.com', company: '', password: 'senha-segura-1', privacyAccepted: true };

function fakeRequest(method: string, url: string, body: unknown, headers: Record<string, string> = {}, ip = '203.0.113.7'): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers: { host: 'demo.exemplo.com', 'x-forwarded-proto': 'https', 'x-forwarded-for': ip, ...headers }, socket: { remoteAddress: ip } });
  return req;
}

function fakeResponse() {
  const result = { status: 0, body: '', headers: {} as Record<string, unknown> };
  const res = {
    headersSent: false,
    set statusCode(value: number) { result.status = value; },
    setHeader: (name: string, value: unknown) => { result.headers[name.toLowerCase()] = value; },
    end: (chunk?: string) => { result.body = chunk ?? ''; },
  } as unknown as ServerResponse;
  return { res, result };
}

const sameOrigin = { origin: 'https://demo.exemplo.com' };

test.describe('demo: validação do cadastro e login', () => {
  test('payloads de SQL injection no e-mail são recusados antes do banco', () => {
    for (const payload of SQL_PAYLOADS) {
      expect(() => parseSignup({ ...validSignup, email: payload })).toThrow();
      expect(() => parseLogin({ email: payload, password: 'qualquer-senha' })).toThrow();
    }
  });

  test('campos fora da lista derrubam o pedido', () => {
    expect(() => parseSignup({ ...validSignup, role: 'master' })).toThrow('Campos inválidos.');
    expect(() => parseLogin({ email: 'ana@exemplo.com', password: 'senha-segura-1', disabled: false })).toThrow('Campos inválidos.');
  });

  test('limites de tamanho e aceite de privacidade', () => {
    expect(() => parseSignup({ ...validSignup, name: 'A' })).toThrow();
    expect(() => parseSignup({ ...validSignup, name: 'A'.repeat(101) })).toThrow();
    expect(() => parseSignup({ ...validSignup, company: 'C'.repeat(101) })).toThrow();
    expect(() => parseSignup({ ...validSignup, password: '1234567' })).toThrow();
    expect(() => parseSignup({ ...validSignup, password: 'x'.repeat(129) })).toThrow();
    expect(() => parseSignup({ ...validSignup, privacyAccepted: 'true' })).toThrow();
    expect(() => parseSignup({ ...validSignup, name: 42 })).toThrow();
  });

  test('normaliza e-mail e trata empresa vazia como nula', () => {
    expect(parseSignup({ ...validSignup, email: '  Ana@Exemplo.COM ' })).toEqual({ name: 'Ana Exemplo', email: 'ana@exemplo.com', company: null, password: 'senha-segura-1' });
  });

  test('autenticador fica em Meus dados: cadastro recusa os campos; ativar exige chave válida e código de 6 dígitos', () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret);
    expect(() => parseSignup({ ...validSignup, totpSecret: secret, totpCode: code })).toThrow('Campos inválidos.');
    expect(parseTotpEnable({ secret, code })).toEqual({ secret, code });
    expect(() => parseTotpEnable({ secret: 'CURTA', code })).toThrow('Chave do autenticador inválida.');
    expect(() => parseTotpEnable({ secret })).toThrow('Código do autenticador inválido.');
    expect(() => parseTotpEnable({ secret, code: '12ab56' })).toThrow('Código do autenticador inválido.');
    expect(() => parseTotpEnable({ secret, code, accountId: 'x' })).toThrow('Campos inválidos.');
    expect(parseTotpDisable({ code: ' 123456 ' })).toEqual({ code: '123456' });
    expect(() => parseTotpDisable({})).toThrow('Código do autenticador inválido.');
    expect(parseLogin({ email: 'ana@exemplo.com', password: 'senha-segura-1' }).code).toBeNull();
    expect(parseLogin({ email: 'ana@exemplo.com', password: 'senha-segura-1', code: ' 123456 ' }).code).toBe('123456');
    expect(() => parseLogin({ email: 'ana@exemplo.com', password: 'senha-segura-1', code: '1234' })).toThrow();
  });

  test('com Turnstile configurado, cadastro e login sem token são recusados antes do banco', async () => {
    process.env.DEMO_TURNSTILE_SECRET = 'segredo-de-teste';
    process.env.DEMO_TURNSTILE_SITE_KEY = 'chave-publica-de-teste';
    try {
      const config = fakeResponse();
      await handleDemoRequest(fakeRequest('GET', '/api/demo/auth/config', undefined), config.res);
      expect(JSON.parse(config.result.body)).toEqual({ captchaSiteKey: 'chave-publica-de-teste', googleClientId: null });
      for (const [path, body] of [['/api/demo/auth/signup', validSignup], ['/api/demo/auth/login', { email: 'ana@exemplo.com', password: 'senha-segura-1' }]] as const) {
        const { res, result } = fakeResponse();
        await handleDemoRequest(fakeRequest('POST', path, body, sameOrigin, '192.0.2.70'), res);
        expect(result.status, path).toBe(400);
        expect(JSON.parse(result.body).error, path).toContain('robô');
      }
    } finally {
      delete process.env.DEMO_TURNSTILE_SECRET;
      delete process.env.DEMO_TURNSTILE_SITE_KEY;
    }
  });

  test('Google: só o ID token, empresa, aceite e código; sem client ID configurado, a rota responde 404 antes do banco', async () => {
    expect(parseGoogleAuth({ credential: 'a.b.c' })).toEqual({ credential: 'a.b.c', company: null, privacyAccepted: false, code: null });
    expect(parseGoogleAuth({ credential: 'a.b.c', company: 'Empresa Exemplo', privacyAccepted: true, code: '123456' })).toEqual({ credential: 'a.b.c', company: 'Empresa Exemplo', privacyAccepted: true, code: '123456' });
    expect(() => parseGoogleAuth({})).toThrow('Login com o Google inválido.');
    expect(() => parseGoogleAuth({ credential: 'a.b.c', email: 'outro@exemplo.com' })).toThrow('Campos inválidos.');
    const { res, result } = fakeResponse();
    await handleDemoRequest(fakeRequest('POST', '/api/demo/auth/google', { credential: 'a.b.c' }, sameOrigin, '192.0.2.80'), res);
    expect(result.status).toBe(404);
  });

  test('Google: ID token só vale com assinatura do Google, mesmo client ID, dentro da validade e e-mail verificado', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keys: GoogleJwk[] = [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1' }];
    const now = Date.now();
    const valid = { iss: 'https://accounts.google.com', aud: 'cliente', exp: Math.floor(now / 1000) + 600, email: 'Ana@Exemplo.com', email_verified: true, name: 'Ana Exemplo' };
    const token = (claims: object, kid = 'k1', key = privateKey) => {
      const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const body = `${part({ alg: 'RS256', kid })}.${part(claims)}`;
      return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
    };
    expect(verifyGoogleIdToken(token(valid), 'cliente', keys, now)).toEqual({ email: 'ana@exemplo.com', name: 'Ana Exemplo' });
    expect(verifyGoogleIdToken(token(valid), 'outro-cliente', keys, now)).toBeUndefined();
    expect(verifyGoogleIdToken(token({ ...valid, exp: Math.floor(now / 1000) - 1 }), 'cliente', keys, now)).toBeUndefined();
    expect(verifyGoogleIdToken(token({ ...valid, email_verified: false }), 'cliente', keys, now)).toBeUndefined();
    expect(verifyGoogleIdToken(token({ ...valid, iss: 'https://atacante.com' }), 'cliente', keys, now)).toBeUndefined();
    expect(verifyGoogleIdToken(token(valid, 'k2'), 'cliente', keys, now)).toBeUndefined();
    expect(verifyGoogleIdToken(token(valid, 'k1', generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), 'cliente', keys, now)).toBeUndefined();
    expect(verifyGoogleIdToken('nao-e-um-token', 'cliente', keys, now)).toBeUndefined();
  });

  test('chave nova do autenticador não toca o banco', async () => {
    const { res, result } = fakeResponse();
    await handleDemoRequest(fakeRequest('GET', '/api/demo/auth/totp-secret', undefined), res);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).totpSecret).toMatch(/^[A-Z2-7]{32}$/);
  });

  test('Meus dados: só nome, e-mail, empresa e senhas; senha vazia vira nula', () => {
    const update = { name: 'Ana Exemplo', email: 'Ana@Exemplo.com', company: '', currentPassword: '', newPassword: '' };
    expect(parseAccountUpdate(update)).toEqual({ name: 'Ana Exemplo', email: 'ana@exemplo.com', company: null, currentPassword: null, newPassword: null });
    expect(() => parseAccountUpdate({ ...update, disabled: false })).toThrow('Campos inválidos.');
    expect(() => parseAccountUpdate({ ...update, id: 'x'.repeat(32) })).toThrow('Campos inválidos.');
    expect(() => parseAccountUpdate({ ...update, newPassword: '1234567' })).toThrow();
    for (const payload of SQL_PAYLOADS) expect(() => parseAccountUpdate({ ...update, email: payload })).toThrow();
    expect(parseAccountDelete({})).toEqual({ currentPassword: null, confirmEmail: null });
    expect(parseAccountDelete({ confirmEmail: 'Ana@Exemplo.com' })).toEqual({ currentPassword: null, confirmEmail: 'ana@exemplo.com' });
    expect(() => parseAccountDelete({ currentPassword: 'senha-segura-1', email: 'ana@exemplo.com' })).toThrow('Campos inválidos.');
  });

  test('atividade: só tela ou ação, com detalhe limitado; sem sessão responde 401 antes do banco', async () => {
    expect(parseActivity({ event: 'tela', detail: ' Início ' })).toEqual({ event: 'tela', detail: 'Início' });
    expect(() => parseActivity({ event: 'cadastro', detail: 'x' })).toThrow('Evento inválido.');
    expect(() => parseActivity({ event: 'acao', detail: 'x'.repeat(201) })).toThrow();
    expect(() => parseActivity({ event: 'acao', detail: 'x', accountId: 'y' })).toThrow('Campos inválidos.');
    const { res, result } = fakeResponse();
    await handleDemoRequest(fakeRequest('POST', '/api/demo/activity', { event: 'tela', detail: 'Início' }, sameOrigin, '192.0.2.60'), res);
    expect(result.status).toBe(401);
  });

  test('Meus dados sem sessão responde 401 antes do banco', async () => {
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const { res, result } = fakeResponse();
      const body = method === 'GET' ? undefined : method === 'DELETE' ? { currentPassword: 'senha-segura-1' } : { name: 'Ana', email: 'ana@exemplo.com' };
      await handleDemoRequest(fakeRequest(method, '/api/demo/auth/account', body, sameOrigin, `192.0.2.${method.length}`), res);
      expect(result.status, method).toBe(401);
    }
  });
});

test.describe('demo: função pública', () => {
  test('escrita de outra origem ou sem Origin é recusada', async () => {
    const headerCases: Record<string, string>[] = [{}, { origin: 'https://atacante.com' }];
    for (const headers of headerCases) {
      const { res, result } = fakeResponse();
      await handleDemoRequest(fakeRequest('POST', '/api/demo/auth/login', { email: 'ana@exemplo.com', password: 'senha-segura-1' }, headers), res);
      expect(result.status).toBe(403);
    }
  });

  test('cadastro e login têm limite por IP antes de tocar o banco', async () => {
    const statuses = async (path: string, body: unknown, times: number) => {
      const out: number[] = [];
      for (let i = 0; i < times; i++) {
        const { res, result } = fakeResponse();
        await handleDemoRequest(fakeRequest('POST', path, body, sameOrigin, '198.51.100.23'), res);
        out.push(result.status);
      }
      return out;
    };
    expect((await statuses('/api/demo/auth/signup', validSignup, 11)).at(-1)).toBe(429);
    expect((await statuses('/api/demo/auth/login', { email: 'ana@exemplo.com', password: 'senha-segura-1' }, 11)).at(-1)).toBe(429);
  });

  test('erro interno não devolve detalhes', async () => {
    const { res, result } = fakeResponse();
    await handleDemoRequest(fakeRequest('GET', '/api/demo/auth/me', undefined, {}, '192.0.2.50'), res);
    expect(result.status).toBe(200);
    const failing = fakeResponse();
    await handleDemoRequest(fakeRequest('POST', '/api/demo/auth/signup', validSignup, sameOrigin, '192.0.2.51'), failing.res);
    expect(failing.result.status).toBe(500);
    expect(failing.result.body).toBe(JSON.stringify({ error: 'Erro interno. Tente de novo em instantes.' }));
  });

  test('rotas fora de cadastro/login não existem', async () => {
    for (const path of ['/api/users', '/api/promotions', '/api/demo-accounts', '/api/logs?source=recorrencias']) {
      const { res, result } = fakeResponse();
      await handleDemoRequest(fakeRequest('GET', path, undefined), res);
      expect(result.status).toBe(404);
    }
  });
});

test.describe('demo: isolamento', () => {
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf-8');
  const filesIn = (dir: string) => readdirSync(join(ROOT, dir)).map((name) => `${dir}/${name}`);

  test('o servidor da demo só toca demo_accounts, sempre com parâmetros', () => {
    for (const file of filesIn('server/demo')) {
      const source = read(file);
      expect(source, file).not.toMatch(/src\/lib\/db|SHARED_DB_|rootEnv/);
      for (const [query] of source.matchAll(/\.query(?:<[^>]+>)?\(\s*`[^`]*`/g)) {
        expect(query.replace(/\$\{(EVENTS_)?TABLE\}/g, ''), `${file}: ${query}`).not.toContain('${');
      }
    }
    expect(read('server/demo/accounts.ts')).toContain("const TABLE = 'demo_accounts';");
    expect(read('server/demo/accounts.ts')).not.toMatch(/\b(users|sessions|promotions|test_runs|logs|atendimento_labels)\b(?=\s|`)/);
  });

  test('o front da demo só chama as rotas de login/cadastro/conta', () => {
    const source = read('src/demo/api.ts');
    expect([...source.matchAll(/fetch\(/g)]).toHaveLength(1);
    expect(source).toContain('fetch(`/api/demo${path}`');
    for (const [, path] of source.matchAll(/request<[^>]*>\('([^']+)'/g)) expect(path).toMatch(/^\/auth\/(signup|login|logout|me|account|account\/totp|totp-secret|config|google)$/);
  });
});

test.describe('demo: testes simulados', () => {
  test.setTimeout(60_000);

  async function run(group: string) {
    const events: TestRunEvent[] = [];
    const stored = await runFakeTests({ group, quantity: undefined, onEvent: (event) => events.push(event) });
    return { events, stored };
  }

  test('emite os mesmos eventos do executor real e termina', async () => {
    const { events, stored } = await run('my-data');
    expect(events[0]).toEqual({ type: 'begin', total: 5 });
    expect(events.filter((event) => event.type === 'test-end')).toHaveLength(5);
    expect(events.at(-1)).toEqual({ type: 'end', success: true });
    expect(new Set(stored.results.map((row) => row.status))).toEqual(new Set(['ok', 'failed', 'not-applicable']));
    expect(stored.finishedAt).not.toBeNull();
  });

  test('cada rodada sorteia ok, falha e N/A de novo', () => {
    const draws = Array.from({ length: 50 }, () => plannedStatuses(8));
    for (const statuses of draws) {
      expect(statuses).toHaveLength(8);
      for (const status of ['ok', 'failed', 'not-applicable']) expect(statuses).toContain(status);
    }
    expect(new Set(draws.map((statuses) => statuses.join())).size).toBeGreaterThan(1);
    expect(plannedStatuses(1)).toHaveLength(1);
  });

  test('cancelar interrompe a rodada', async () => {
    const controller = new AbortController();
    const promise = runFakeTests({ group: 'participant-registration', quantity: undefined, onEvent: () => controller.abort(), signal: controller.signal });
    await expect(promise).rejects.toThrow();
  });
});
