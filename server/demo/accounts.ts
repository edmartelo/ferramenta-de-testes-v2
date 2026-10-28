import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { hashPassword, verifyPassword } from '../../src/lib/password.ts';
import { generateTotpSecret, isValidTotpSecret, matchTotpStep } from '../../src/lib/totp.ts';
import { BadRequestError, readJsonBody, sendJson } from '../http-utils.ts';
import { googleKeys, verifyGoogleIdToken } from './google.ts';
import type { DemoAccountEvent } from './schema.ts';

/** Tabela das contas; o `demo_app` lê, insere, apaga e só altera as colunas de `DEMO_UPDATABLE_COLUMNS`. */
const TABLE = 'demo_accounts';
/** Histórico de cadastro, edição, exclusão, telas e ações; o `demo_app` insere e, ao excluir a conta, apaga o dela. */
const EVENTS_TABLE = 'demo_account_events';
const COOKIE_NAME = 'ftd_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 4 * 1024;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
const MAX_SIGNUPS_PER_IP = 10;
const SIGNUP_WINDOW_MS = 30 * 60 * 1000;
const MAX_ACTIVITY_PER_WINDOW = 300;
const ACTIVITY_WINDOW_MS = 30 * 60 * 1000;
const ACTIVITY_EVENTS: readonly DemoAccountEvent[] = ['tela', 'acao'];
const INVALID_LOGIN = 'E-mail ou senha inválidos.';
const TOO_MANY = 'Muitas tentativas. Tente de novo em alguns minutos.';
const SIGNUP_RECEIVED = 'Cadastro recebido. Entre com seu e-mail e senha.';
const SESSION_EXPIRED = 'Sessão expirada. Entre de novo.';
const WRONG_PASSWORD = 'Senha atual incorreta.';
const INVALID_TOTP = 'Código do autenticador inválido.';
const CAPTCHA_FAILED = 'Não conseguimos confirmar que você não é um robô. Recarregue a página e tente de novo.';
const CAPTCHA_TIMEOUT_MS = 5_000;

const EMAIL_PATTERN = /^[^\s@"'<>()\\,;:]+@[^\s@"'<>()\\,;:]+\.[a-z]{2,}$/i;

function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Variável ${key} não configurada.`);
  return value;
}

/** PEM colado (hospedagem) ou caminho do arquivo (local). */
function sslCa(value: string): string {
  if (value.includes('-----BEGIN CERTIFICATE-----')) return value.replace(/\\n/g, '\n');
  if (!existsSync(value)) throw new Error('DEMO_DB_SSL_CA aponta para um arquivo que não existe.');
  return readFileSync(value, 'utf-8');
}

const poolCache = globalThis as unknown as { __demoDbPool?: Pool };

function pool(): Pool {
  return (poolCache.__demoDbPool ??= mysql.createPool({
    host: env('DEMO_DB_HOST'),
    port: Number(process.env.DEMO_DB_PORT ?? 3306),
    user: env('DEMO_DB_USER'),
    password: env('DEMO_DB_PASSWORD'),
    database: env('DEMO_DB_NAME'),
    ssl: { ca: sslCa(env('DEMO_DB_SSL_CA')), rejectUnauthorized: true },
    connectionLimit: 2,
    charset: 'utf8mb4',
    multipleStatements: false,
  }));
}

/** Chave do 2FA derivada do segredo da sessão: sem variável de ambiente nova; trocar `DEMO_SESSION_SECRET` invalida os autenticadores. */
function totpKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', env('DEMO_SESSION_SECRET'), 'ferramenta-demo', 'totp-secret', 32));
}

/** AES-256-GCM: quem só lê o banco não gera os códigos. */
function encryptTotp(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', totpKey(), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}

function decryptTotp(stored: string): string {
  const [iv, tag, data] = stored.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !data) throw new Error('Segredo do autenticador malformado.');
  const decipher = createDecipheriv('aes-256-gcm', totpKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function hmac(value: string): string {
  return createHmac('sha256', env('DEMO_SESSION_SECRET')).update(value).digest('base64url');
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'desconhecido';
}

/** Por instância da função: freia rajadas; o teto de cadastros por IP fica no banco. */
const ipAttempts = new Map<string, { count: number; resetAt: number }>();

function ipRateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (ipAttempts.size > 10_000) for (const [k, v] of ipAttempts) if (v.resetAt <= now) ipAttempts.delete(k);
  const entry = ipAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    ipAttempts.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

interface SessionPayload {
  id: string;
  name: string;
  exp: number;
}

function signSession(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body)}`;
}

function readSession(req: IncomingMessage): SessionPayload | undefined {
  const cookie = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  const token = cookie?.slice(COOKIE_NAME.length + 1);
  const [body, signature] = token?.split('.') ?? [];
  if (!body || !signature) return undefined;
  const expected = Buffer.from(hmac(body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as SessionPayload;
    return typeof payload.id === 'string' && typeof payload.exp === 'number' && payload.exp > Date.now() ? payload : undefined;
  } catch {
    return undefined;
  }
}

function isSecure(req: IncomingMessage): boolean {
  return req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req: IncomingMessage, res: ServerResponse, value: string, maxAgeSeconds: number): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${isSecure(req) ? '; Secure' : ''}`);
}

/** Toda escrita exige `Origin` do próprio site: CSRF por formulário de outro domínio não passa. */
export function isForeignWrite(req: IncomingMessage): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  const origin = req.headers.origin;
  const self = `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`;
  return !origin || (origin !== self && origin !== process.env.DEMO_ALLOWED_ORIGIN);
}

/** Campos fora da lista derrubam o pedido: nada chega ao SQL além do que é validado aqui. */
function pickFields(body: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length) throw new BadRequestError('Campos inválidos.');
  return body;
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new BadRequestError(`${field} inválido.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new BadRequestError(`${field} precisa ter entre ${min} e ${max} caracteres.`);
  return trimmed;
}

function email(value: unknown): string {
  const normalized = text(value, 'E-mail', 6, 254).toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) throw new BadRequestError('E-mail inválido.');
  return normalized;
}

function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8) throw new BadRequestError('Senha precisa ter no mínimo 8 caracteres.');
  if (value.length > 128) throw new BadRequestError('Senha longa demais.');
  return value;
}

function totpCode(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value.trim())) throw new BadRequestError(INVALID_TOTP);
  return value.trim();
}

export interface SignupInput {
  name: string;
  email: string;
  company: string | null;
  password: string;
}

function optionalCompany(value: unknown): string | null {
  return value === undefined || value === '' || value === null ? null : text(value, 'Empresa', 1, 100);
}

export function parseSignup(body: Record<string, unknown>): SignupInput {
  pickFields(body, ['name', 'email', 'company', 'password', 'privacyAccepted']);
  if (body.privacyAccepted !== true) throw new BadRequestError('Aceite o aviso de privacidade para continuar.');
  return { name: text(body.name, 'Nome', 2, 100), email: email(body.email), company: optionalCompany(body.company), password: password(body.password) };
}

/** "Continuar com o Google": o ID token traz nome e e-mail; conta nova manda também empresa e o aceite. */
export function parseGoogleAuth(body: Record<string, unknown>): { credential: string; company: string | null; privacyAccepted: boolean; code: string | null } {
  pickFields(body, ['credential', 'company', 'privacyAccepted', 'code']);
  if (typeof body.credential !== 'string' || !body.credential || body.credential.length > 4096) throw new BadRequestError('Login com o Google inválido.');
  return {
    credential: body.credential,
    company: optionalCompany(body.company),
    privacyAccepted: body.privacyAccepted === true,
    code: body.code === undefined || body.code === '' ? null : totpCode(body.code),
  };
}

/** Ativar o autenticador em Meus dados: chave gerada por `/auth/totp-secret` e o código que o app mostrou. */
export function parseTotpEnable(body: Record<string, unknown>): { secret: string; code: string } {
  pickFields(body, ['secret', 'code']);
  if (typeof body.secret !== 'string' || !isValidTotpSecret(body.secret)) throw new BadRequestError('Chave do autenticador inválida.');
  return { secret: body.secret, code: totpCode(body.code) };
}

export function parseTotpDisable(body: Record<string, unknown>): { code: string } {
  pickFields(body, ['code']);
  return { code: totpCode(body.code) };
}

export function parseLogin(body: Record<string, unknown>): { email: string; password: string; code: string | null } {
  pickFields(body, ['email', 'password', 'code']);
  const code = body.code === undefined || body.code === '' ? null : totpCode(body.code);
  return { email: email(body.email), password: password(body.password), code };
}

function optionalPassword(value: unknown): string | null {
  return value === undefined || value === '' ? null : password(value);
}

export interface AccountUpdateInput {
  name: string;
  email: string;
  company: string | null;
  currentPassword: string | null;
  newPassword: string | null;
}

export function parseAccountUpdate(body: Record<string, unknown>): AccountUpdateInput {
  pickFields(body, ['name', 'email', 'company', 'currentPassword', 'newPassword']);
  return {
    name: text(body.name, 'Nome', 2, 100),
    email: email(body.email),
    company: optionalCompany(body.company),
    currentPassword: optionalPassword(body.currentPassword),
    newPassword: optionalPassword(body.newPassword),
  };
}

/** Conta com senha confirma com ela; conta só do Google, digitando o próprio e-mail. */
export function parseAccountDelete(body: Record<string, unknown>): { currentPassword: string | null; confirmEmail: string | null } {
  pickFields(body, ['currentPassword', 'confirmEmail']);
  return {
    currentPassword: optionalPassword(body.currentPassword),
    confirmEmail: body.confirmEmail === undefined || body.confirmEmail === '' ? null : email(body.confirmEmail),
  };
}

export function parseActivity(body: Record<string, unknown>): { event: DemoAccountEvent; detail: string } {
  pickFields(body, ['event', 'detail']);
  if (!ACTIVITY_EVENTS.includes(body.event as DemoAccountEvent)) throw new BadRequestError('Evento inválido.');
  return { event: body.event as DemoAccountEvent, detail: text(body.detail, 'Detalhe', 1, 200) };
}

/**
 * Cloudflare Turnstile: tira `captchaToken` do corpo antes da validação dos campos. Sem `DEMO_TURNSTILE_SECRET` (rodando local)
 * não confere; com ela, token ausente, de outra ação ou falha da Cloudflare recusam.
 */
async function captchaOk(body: Record<string, unknown>, action: 'signup' | 'login', ip: string): Promise<boolean> {
  const token = body.captchaToken;
  delete body.captchaToken;
  const secret = process.env.DEMO_TURNSTILE_SECRET;
  if (!secret) return true;
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(CAPTCHA_TIMEOUT_MS),
    });
    const result = (await response.json()) as { success?: boolean; action?: string; metadata?: { result_with_testing_key?: boolean } };
    // As chaves de teste públicas da Cloudflare não devolvem `action`; só valem se o próprio segredo configurado for de teste.
    return result.success === true && (result.action === action || result.metadata?.result_with_testing_key === true);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Ação feita na conta (autenticador, por exemplo), no mesmo histórico que o Master vê em Logs. */
async function recordAction(accountId: string, detail: string): Promise<void> {
  await pool().query(`INSERT INTO ${EVENTS_TABLE} (account_id, event, name, email, company, detail) SELECT id, 'acao', name, email, company, ? FROM ${TABLE} WHERE id = ?`, [
    detail,
    accountId,
  ]);
}

async function recordEvent(accountId: string, event: DemoAccountEvent, data: { name: string; email: string; company: string | null }): Promise<void> {
  await pool().query(`INSERT INTO ${EVENTS_TABLE} (account_id, event, name, email, company) VALUES (?, ?, ?, ?, ?)`, [
    accountId,
    event,
    data.name,
    data.email,
    data.company,
  ]);
}

async function signup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = clientIp(req);
  if (ipRateLimited(`signup:${ip}`, MAX_SIGNUPS_PER_IP, SIGNUP_WINDOW_MS)) return void sendJson(res, 429, { error: TOO_MANY });
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const human = await captchaOk(body, 'signup', ip);
  const input = parseSignup(body);
  if (!human) return void sendJson(res, 400, { error: CAPTCHA_FAILED });
  if (await signupsFromIpExceeded(ip)) return void sendJson(res, 429, { error: TOO_MANY });
  // E-mail já cadastrado responde igual: o cadastro não revela quem tem conta.
  await createAccount(ip, input, await hashPassword(input.password));
  sendJson(res, 200, { ok: true, message: SIGNUP_RECEIVED });
}

/** O teto por IP fica no banco: vale entre instâncias da função. */
async function signupsFromIpExceeded(ip: string): Promise<boolean> {
  const [recent] = await pool().query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM ${TABLE} WHERE signup_ip_hmac = ? AND created_at > NOW() - INTERVAL ? SECOND`,
    [hmac(`ip:${ip}`), SIGNUP_WINDOW_MS / 1000],
  );
  return Number(recent[0]?.total ?? 0) >= MAX_SIGNUPS_PER_IP;
}

/** `passwordHash` nulo = conta só do Google. Devolve o id, ou nada se o e-mail já existe. */
async function createAccount(ip: string, data: { name: string; email: string; company: string | null }, passwordHash: string | null): Promise<string | undefined> {
  const id = randomBytes(16).toString('hex');
  const [result] = await pool().query<ResultSetHeader>(
    `INSERT IGNORE INTO ${TABLE} (id, name, email, company, password_hash, privacy_accepted_at, signup_ip_hmac) VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
    [id, data.name, data.email, data.company, passwordHash, hmac(`ip:${ip}`)],
  );
  if (!result.affectedRows) return undefined;
  await recordEvent(id, 'cadastro', data);
  return id;
}

/** Conta pelo e-mail com o que o login precisa; parâmetro sempre, nada interpolado além da tabela. */
async function loginAccount(email: string): Promise<RowDataPacket | undefined> {
  const [rows] = await pool().query<RowDataPacket[]>(
    `SELECT id, name, password_hash AS passwordHash, totp_secret AS totpSecret, totp_last_step AS totpLastStep, failed_logins AS failedLogins,
       locked_until AS lockedUntil, disabled
     FROM ${TABLE} WHERE email = ?`,
    [email],
  );
  return rows[0];
}

function isLocked(account: RowDataPacket): boolean {
  return account.lockedUntil !== null && Number(account.lockedUntil) > Date.now();
}

async function registerFailedLogin(account: RowDataPacket): Promise<void> {
  const failed = Number(account.failedLogins) + 1;
  await pool().query(`UPDATE ${TABLE} SET failed_logins = ?, locked_until = ? WHERE id = ?`, [
    failed >= MAX_FAILED_LOGINS ? 0 : failed,
    failed >= MAX_FAILED_LOGINS ? Date.now() + LOCK_MS : null,
    account.id,
  ]);
}

/**
 * Identidade já conferida (senha ou Google): conta com autenticador sem código só avisa que falta; código errado ou repetido
 * conta como tentativa falha. Depois abre a sessão.
 */
async function completeLogin(req: IncomingMessage, res: ServerResponse, account: RowDataPacket, code: string | null): Promise<void> {
  let step: number | undefined;
  if (account.totpSecret) {
    if (code === null) return void sendJson(res, 200, { totpRequired: true });
    step = matchTotpStep(decryptTotp(String(account.totpSecret)), code);
    if (step === undefined || (account.totpLastStep !== null && step <= Number(account.totpLastStep))) {
      await registerFailedLogin(account);
      return void sendJson(res, 401, { error: INVALID_TOTP });
    }
  }
  await pool().query(
    `UPDATE ${TABLE} SET failed_logins = 0, locked_until = NULL, login_count = login_count + 1, last_login_at = NOW(), totp_last_step = COALESCE(?, totp_last_step)
     WHERE id = ?`,
    [step ?? null, account.id],
  );
  setSessionCookie(req, res, signSession({ id: String(account.id), name: String(account.name), exp: Date.now() + SESSION_TTL_MS }), SESSION_TTL_MS / 1000);
  sendJson(res, 200, { ok: true });
}

async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = clientIp(req);
  if (ipRateLimited(`login:${ip}`, 10, LOCK_MS)) return void sendJson(res, 429, { error: TOO_MANY });
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const human = await captchaOk(body, 'login', ip);
  const input = parseLogin(body);
  if (!human) return void sendJson(res, 400, { error: CAPTCHA_FAILED });
  const account = await loginAccount(input.email);
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  // Conta só do Google não tem senha: compara com o hash falso para o tempo de resposta não revelar isso.
  const hash = account?.passwordHash ? String(account.passwordHash) : await dummyHash;
  const valid = (await verifyPassword(input.password, hash)) && Boolean(account?.passwordHash);
  if (!account || !valid || isLocked(account) || account.disabled) {
    if (account && !valid && !isLocked(account)) await registerFailedLogin(account);
    return void sendJson(res, 401, { error: INVALID_LOGIN });
  }
  await completeLogin(req, res, account, input.code);
}

/** Conta nova pelo Google responde `signupRequired` com nome e e-mail até vir o aceite de privacidade. */
async function googleAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = clientIp(req);
  if (ipRateLimited(`google:${ip}`, 10, LOCK_MS)) return void sendJson(res, 429, { error: TOO_MANY });
  const input = parseGoogleAuth(await readJsonBody(req, MAX_BODY_BYTES));
  const clientId = process.env.DEMO_GOOGLE_CLIENT_ID;
  if (!clientId) return void sendJson(res, 404, { error: 'Login com o Google não configurado.' });
  const identity =
    verifyGoogleIdToken(input.credential, clientId, await googleKeys()) ?? verifyGoogleIdToken(input.credential, clientId, await googleKeys(true));
  if (!identity) return void sendJson(res, 401, { error: 'Não foi possível confirmar o login com o Google. Tente de novo.' });
  let account = await loginAccount(identity.email);
  if (!account) {
    if (!input.privacyAccepted) return void sendJson(res, 200, { signupRequired: true, name: identity.name, email: identity.email });
    if (ipRateLimited(`signup:${ip}`, MAX_SIGNUPS_PER_IP, SIGNUP_WINDOW_MS) || (await signupsFromIpExceeded(ip))) return void sendJson(res, 429, { error: TOO_MANY });
    await createAccount(ip, { ...identity, company: input.company }, null);
    account = await loginAccount(identity.email);
  }
  if (!account || isLocked(account) || account.disabled) return void sendJson(res, 401, { error: INVALID_LOGIN });
  await completeLogin(req, res, account, input.code);
}

/** Chaves públicas do Turnstile e do Google vêm das variáveis de ambiente, sem rebuild; `null` desliga cada uma no front. */
function publicConfig(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { captchaSiteKey: process.env.DEMO_TURNSTILE_SITE_KEY || null, googleClientId: process.env.DEMO_GOOGLE_CLIENT_ID || null });
}

/** Chave nova para ativar o autenticador em Meus dados; só vale depois que o código dela confere. */
function totpSecret(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { totpSecret: generateTotpSecret() });
}

function logout(req: IncomingMessage, res: ServerResponse): void {
  setSessionCookie(req, res, '', 0);
  sendJson(res, 200, { ok: true });
}

/** Conta desativada cai na próxima checagem de sessão, não só quando o cookie vence. */
async function me(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = readSession(req);
  if (!session) return void sendJson(res, 200, { authenticated: false });
  const [rows] = await pool().query<RowDataPacket[]>(`SELECT name, disabled FROM ${TABLE} WHERE id = ?`, [session.id]);
  const account = rows[0];
  if (!account || account.disabled) {
    setSessionCookie(req, res, '', 0);
    return void sendJson(res, 200, { authenticated: false });
  }
  sendJson(res, 200, { authenticated: true, id: session.id, name: String(account.name) });
}

/** Conta ativa da sessão; sem ela, derruba o cookie e responde 401. */
async function sessionAccount(req: IncomingMessage, res: ServerResponse): Promise<RowDataPacket | undefined> {
  const session = readSession(req);
  const [rows] = session
    ? await pool().query<RowDataPacket[]>(
        `SELECT id, name, email, company, password_hash AS passwordHash, totp_secret AS totpSecret, totp_last_step AS totpLastStep, disabled FROM ${TABLE} WHERE id = ?`,
        [session.id],
      )
    : [[] as RowDataPacket[]];
  const account = rows[0];
  if (account && !account.disabled) return account;
  setSessionCookie(req, res, '', 0);
  sendJson(res, 401, { error: SESSION_EXPIRED });
  return undefined;
}

async function getAccount(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const account = await sessionAccount(req, res);
  if (!account) return;
  sendJson(res, 200, {
    name: String(account.name),
    email: String(account.email),
    company: account.company === null ? null : String(account.company),
    hasPassword: account.passwordHash !== null,
    totpEnabled: account.totpSecret !== null,
  });
}

async function enableTotp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (ipRateLimited(`account:${clientIp(req)}`, 10, LOCK_MS)) return void sendJson(res, 429, { error: TOO_MANY });
  const input = parseTotpEnable(await readJsonBody(req, MAX_BODY_BYTES));
  const account = await sessionAccount(req, res);
  if (!account) return;
  if (account.totpSecret !== null) return void sendJson(res, 400, { error: 'O autenticador já está ativado.' });
  const step = matchTotpStep(input.secret, input.code);
  if (step === undefined) return void sendJson(res, 400, { error: INVALID_TOTP });
  await pool().query(`UPDATE ${TABLE} SET totp_secret = ?, totp_last_step = ? WHERE id = ?`, [encryptTotp(input.secret), step, account.id]);
  await recordAction(String(account.id), 'Ativou o autenticador');
  sendJson(res, 200, { ok: true });
}

/** Desativar pede um código atual do app: quem só tem a sessão aberta não tira a proteção. */
async function disableTotp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (ipRateLimited(`account:${clientIp(req)}`, 10, LOCK_MS)) return void sendJson(res, 429, { error: TOO_MANY });
  const input = parseTotpDisable(await readJsonBody(req, MAX_BODY_BYTES));
  const account = await sessionAccount(req, res);
  if (!account) return;
  if (account.totpSecret === null) return void sendJson(res, 400, { error: 'O autenticador não está ativado.' });
  const step = matchTotpStep(decryptTotp(String(account.totpSecret)), input.code);
  if (step === undefined || (account.totpLastStep !== null && step <= Number(account.totpLastStep))) return void sendJson(res, 400, { error: INVALID_TOTP });
  await pool().query(`UPDATE ${TABLE} SET totp_secret = NULL, totp_last_step = NULL WHERE id = ?`, [account.id]);
  await recordAction(String(account.id), 'Desativou o autenticador');
  sendJson(res, 200, { ok: true });
}

/** Trocar e-mail ou senha pede a senha atual, se a conta tiver uma; nome e empresa não. Conta só do Google pode criar senha. */
async function updateAccount(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (ipRateLimited(`account:${clientIp(req)}`, 10, LOCK_MS)) return void sendJson(res, 429, { error: TOO_MANY });
  const input = parseAccountUpdate(await readJsonBody(req, MAX_BODY_BYTES));
  const account = await sessionAccount(req, res);
  if (!account) return;
  const hasPassword = account.passwordHash !== null;
  if (hasPassword && (input.email !== String(account.email) || input.newPassword !== null)) {
    if (input.currentPassword === null || !(await verifyPassword(input.currentPassword, String(account.passwordHash)))) {
      return void sendJson(res, 400, { error: WRONG_PASSWORD });
    }
  }
  const passwordHash = input.newPassword === null ? account.passwordHash : await hashPassword(input.newPassword);
  try {
    await pool().query(`UPDATE ${TABLE} SET name = ?, email = ?, company = ?, password_hash = ? WHERE id = ?`, [
      input.name,
      input.email,
      input.company,
      passwordHash,
      account.id,
    ]);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ER_DUP_ENTRY') return void sendJson(res, 400, { error: 'Não foi possível usar esse e-mail.' });
    throw error;
  }
  await recordEvent(String(account.id), 'edicao', input);
  setSessionCookie(req, res, signSession({ id: String(account.id), name: input.name, exp: Date.now() + SESSION_TTL_MS }), SESSION_TTL_MS / 1000);
  sendJson(res, 200, { ok: true, name: input.name });
}

/** Apaga a conta e o histórico dela (aviso no cadastro, em Meus dados e na política de privacidade). */
async function deleteAccount(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (ipRateLimited(`account:${clientIp(req)}`, 10, LOCK_MS)) return void sendJson(res, 429, { error: TOO_MANY });
  const input = parseAccountDelete(await readJsonBody(req, MAX_BODY_BYTES));
  const account = await sessionAccount(req, res);
  if (!account) return;
  if (account.passwordHash !== null) {
    if (input.currentPassword === null || !(await verifyPassword(input.currentPassword, String(account.passwordHash)))) {
      return void sendJson(res, 400, { error: WRONG_PASSWORD });
    }
  } else if (input.confirmEmail !== String(account.email)) {
    return void sendJson(res, 400, { error: 'Digite o e-mail da conta para confirmar.' });
  }
  // Excluir apaga também o histórico da conta; fica só o registro anônimo de que houve exclusão.
  await pool().query(`DELETE FROM ${EVENTS_TABLE} WHERE account_id = ?`, [account.id]);
  await recordEvent(String(account.id), 'exclusao', { name: 'Conta excluída', email: '', company: null });
  await pool().query(`DELETE FROM ${TABLE} WHERE id = ?`, [account.id]);
  setSessionCookie(req, res, '', 0);
  sendJson(res, 200, { ok: true });
}

/** Tela visitada ou ação na demo; nome, e-mail e empresa vêm da conta, que precisa estar ativa. Acima do limite, descarta calado. */
async function recordActivity(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const input = parseActivity(await readJsonBody(req, MAX_BODY_BYTES));
  const session = readSession(req);
  if (!session) return void sendJson(res, 401, { error: SESSION_EXPIRED });
  if (!ipRateLimited(`activity:${session.id}`, MAX_ACTIVITY_PER_WINDOW, ACTIVITY_WINDOW_MS)) {
    await pool().query(
      `INSERT INTO ${EVENTS_TABLE} (account_id, event, name, email, company, detail) SELECT id, ?, name, email, company, ? FROM ${TABLE} WHERE id = ? AND NOT disabled`,
      [input.event, input.detail, session.id],
    );
  }
  sendJson(res, 200, { ok: true });
}

/** Únicas rotas da demo que falam com o banco. */
export async function handleDemoAuthRoute(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const handler = ({
    'POST /api/demo/auth/signup': signup,
    'POST /api/demo/auth/login': login,
    'POST /api/demo/auth/google': googleAuth,
    'GET /api/demo/auth/totp-secret': totpSecret,
    'GET /api/demo/auth/config': publicConfig,
    'POST /api/demo/auth/logout': logout,
    'GET /api/demo/auth/me': me,
    'GET /api/demo/auth/account': getAccount,
    'PATCH /api/demo/auth/account': updateAccount,
    'DELETE /api/demo/auth/account': deleteAccount,
    'POST /api/demo/auth/account/totp': enableTotp,
    'DELETE /api/demo/auth/account/totp': disableTotp,
    'POST /api/demo/activity': recordActivity,
  } as Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void> | void>)[`${req.method} ${pathname}`];
  if (!handler) return false;
  await handler(req, res);
  return true;
}
