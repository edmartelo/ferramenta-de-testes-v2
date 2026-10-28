import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { hashPassword, needsRehash, verifyPassword } from '../src/lib/password.ts';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../src/lib/secret-box.ts';
import { generateTotpSecret, isValidTotpSecret, matchTotpStep } from '../src/lib/totp.ts';
import { db } from '../src/lib/db.ts';
import { readJsonBody, sendJson } from './http-utils.ts';

const COOKIE_NAME = 'ft_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Cada processo guarda as sessões em cache e revalida no banco a cada minuto: usuário excluído cai em até 1 minuto. */
const SESSION_RECHECK_MS = 60 * 1000;
const COOKIE_ATTRIBUTES = 'HttpOnly; Path=/; SameSite=Lax';
const MIN_PASSWORD_LENGTH = 8;
/** Senha provisória vale 72 h: quem não fizer o primeiro acesso nesse prazo é cadastrado de novo pelo Master. */
const PENDING_TTL_MS = 72 * 60 * 60 * 1000;

export const USER_ROLES = ['master', 'tester'] as const;
export type UserRole = (typeof USER_ROLES)[number];

interface StoredUser {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  totpSecret: string;
  role: UserRole;
  /** Criado por um Master: no primeiro login troca a senha provisória e cadastra o autenticador. */
  mustSetup: boolean;
  createdAt: Date;
}

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  pending: boolean;
  /** Senha provisória vencida: o Master exclui e cadastra de novo. */
  expired: boolean;
  createdAt: string;
}

const USER_COLUMNS = 'id, name, email, password_hash AS passwordHash, totp_secret AS totpSecret, role, must_setup AS mustSetup, created_at AS createdAt';

function toStoredUser(row: RowDataPacket | undefined): StoredUser | undefined {
  return row ? ({ ...row, mustSetup: Boolean(row.mustSetup), createdAt: new Date(row.createdAt) } as StoredUser) : undefined;
}

/** `totpStep` = passo do código usado no cadastro, pra ele não valer de novo no login. */
async function insertUser(user: Omit<StoredUser, 'createdAt'>, totpStep: number | null = null): Promise<void> {
  await (await db()).query(
    'INSERT INTO users (id, name, email, password_hash, totp_secret, totp_last_step, role, must_setup) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [user.id, user.name, user.email, user.passwordHash, user.totpSecret, totpStep, user.role, user.mustSetup],
  );
}

function isPendingExpired(mustSetup: boolean, createdAt: Date): boolean {
  return mustSetup && Date.now() - createdAt.getTime() > PENDING_TTL_MS;
}

async function findUserByEmail(email: string): Promise<StoredUser | undefined> {
  const [rows] = await (await db()).query<RowDataPacket[]>(`SELECT ${USER_COLUMNS} FROM users WHERE LOWER(email) = ?`, [email.trim().toLowerCase()]);
  return toStoredUser(rows[0]);
}

async function findUserById(id: string): Promise<StoredUser | undefined> {
  const [rows] = await (await db()).query<RowDataPacket[]>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
  return toStoredUser(rows[0]);
}

async function hasUsers(): Promise<boolean> {
  const [rows] = await (await db()).query<RowDataPacket[]>('SELECT 1 FROM users LIMIT 1');
  return rows.length > 0;
}

let dummyPasswordHash: Promise<string> | undefined;

/** E-mail sem conta também paga o scrypt: o tempo de resposta não revela quem está cadastrado. */
function passwordHashOrDummy(user: StoredUser | undefined): Promise<string> {
  if (user) return Promise.resolve(user.passwordHash);
  dummyPasswordHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyPasswordHash;
}

/** Marca o passo como usado; `false` se ele (ou um mais novo) já entrou, ou seja, o código está sendo reaproveitado. */
async function claimTotpStep(userId: string, step: number): Promise<boolean> {
  const [result] = await (await db()).query<ResultSetHeader>(
    'UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)',
    [step, userId, step],
  );
  return result.affectedRows === 1;
}

/** Só aceita o segredo no formato gerado aqui e devolve o passo do código, ou `undefined` se não bater. */
function confirmNewTotp(totpSecret: string, code: string): number | undefined {
  return isValidTotpSecret(totpSecret) ? matchTotpStep(totpSecret, code) : undefined;
}

function passwordError(password: string): string | undefined {
  return password.length < MIN_PASSWORD_LENGTH ? `Senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.` : undefined;
}

interface Session {
  userId: string;
  role: UserRole;
  expiresAt: number;
  checkedAt: number;
}

/** Cache deste processo; a fonte é a tabela `sessions`, que guarda só o hash do token. */
const sessions = new Map<string, Session>();

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createSession(user: Pick<StoredUser, 'id' | 'role'>): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const pool = await db();
  await pool.query('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [sha256(token), user.id, expiresAt]);
  sessions.set(token, { userId: user.id, role: user.role, expiresAt, checkedAt: Date.now() });
  return token;
}

async function endSession(token: string): Promise<void> {
  sessions.delete(token);
  await (await db()).query('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

function getSession(token: string | undefined): Session | undefined {
  if (!token) return undefined;
  const entry = sessions.get(token);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  return entry;
}

/** Revalida no banco de tempos em tempos: usuário excluído perde a sessão e mudança de nível vale sem novo login. */
async function getLiveSession(req: IncomingMessage): Promise<Session | undefined> {
  const token = getSessionToken(req);
  if (!token) return undefined;
  const cached = getSession(token);
  if (cached && Date.now() - cached.checkedAt < SESSION_RECHECK_MS) return cached;
  const [rows] = await (await db()).query<RowDataPacket[]>(
    'SELECT s.user_id AS userId, s.expires_at AS expiresAt, u.role, u.must_setup AS mustSetup FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    [sha256(token)],
  );
  const row = rows[0];
  if (!row || Number(row.expiresAt) < Date.now() || row.mustSetup) {
    if (row) await endSession(token);
    else sessions.delete(token);
    return undefined;
  }
  const entry: Session = { userId: row.userId, role: row.role, expiresAt: Number(row.expiresAt), checkedAt: Date.now() };
  sessions.set(token, entry);
  return entry;
}

async function endUserSessions(userId: string): Promise<void> {
  for (const [token, entry] of sessions) if (entry.userId === userId) sessions.delete(token);
  await (await db()).query('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    try {
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // cookie malformado de outro projeto em localhost — ignora
    }
  }
  return out;
}

function getSessionToken(req: IncomingMessage): string | undefined {
  return parseCookies(req)[COOKIE_NAME];
}

function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`);
}

export function getAuthenticatedUserId(req: IncomingMessage): string | undefined {
  return getSession(getSessionToken(req))?.userId;
}

/** Chamador já garantiu `requireAuth`, que deixa a sessão no cache. */
export function getAuthenticatedRole(req: IncomingMessage): UserRole | undefined {
  return getSession(getSessionToken(req))?.role;
}

export async function requireAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (await getLiveSession(req)) return true;
  sendJson(res, 401, { error: 'Não autenticado.' });
  return false;
}

const EMAIL_TAKEN = { error: 'Já existe um cadastro com esse e-mail.' };

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? '';
}

/** Hash de IP + e-mail: as tentativas valem pra todas as instâncias sem guardar os dois em claro. */
function loginLimitKey(req: IncomingMessage, email: string): string {
  return sha256(`${clientIp(req)}|${email.toLowerCase()}`);
}

/** Conta a tentativa antes de conferir a senha, senão requisições em paralelo passam juntas do limite; login certo zera. */
async function allowLoginAttempt(key: string): Promise<boolean> {
  const pool = await db();
  await pool.query('DELETE FROM login_attempts WHERE reset_at < ?', [Date.now()]);
  await pool.query('INSERT INTO login_attempts (limit_key, attempts, reset_at) VALUES (?, 1, ?) ON DUPLICATE KEY UPDATE attempts = attempts + 1', [
    key,
    Date.now() + LOGIN_WINDOW_MS,
  ]);
  const [rows] = await pool.query<RowDataPacket[]>('SELECT attempts FROM login_attempts WHERE limit_key = ?', [key]);
  return Number(rows[0]?.attempts ?? 0) <= LOGIN_MAX_ATTEMPTS;
}

async function clearLoginAttempts(key: string): Promise<void> {
  await (await db()).query('DELETE FROM login_attempts WHERE limit_key = ?', [key]);
}

const TOO_MANY_ATTEMPTS = { error: 'Muitas tentativas de login. Aguarde 15 minutos e tente de novo.' };
const INVALID_CREDENTIALS = { error: 'E-mail ou senha inválidos.' };
const PENDING_EXPIRED = { error: 'A senha provisória venceu (72 h). Peça a um Master para cadastrar você de novo.' };
const INVALID_TOTP = { error: 'Código do autenticador inválido.' };

/** Confere e-mail/senha com limite de tentativas; responde o erro e devolve `undefined` quando falha. */
async function checkCredentials(req: IncomingMessage, res: ServerResponse, email: string, password: string): Promise<StoredUser | undefined> {
  if (!(await allowLoginAttempt(loginLimitKey(req, email)))) {
    sendJson(res, 429, TOO_MANY_ATTEMPTS);
    return undefined;
  }
  const user = await findUserByEmail(email);
  const passwordOk = await verifyPassword(password, await passwordHashOrDummy(user));
  if (!user || !passwordOk) {
    sendJson(res, 401, INVALID_CREDENTIALS);
    return undefined;
  }
  if (isPendingExpired(user.mustSetup, user.createdAt)) {
    sendJson(res, 403, PENDING_EXPIRED);
    return undefined;
  }
  return user;
}

/** Primeiro acesso de quem o Master cadastrou: senha provisória + senha nova (+ autenticador na confirmação). */
async function parseFirstAccess(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<{ user: StoredUser; newPassword: string } | undefined> {
  const user = await checkCredentials(req, res, String(body.email ?? '').trim(), String(body.password ?? ''));
  if (!user) return undefined;
  if (!user.mustSetup) {
    sendJson(res, 409, { error: 'Esse usuário já concluiu o primeiro acesso.' });
    return undefined;
  }
  const newPassword = String(body.newPassword ?? '');
  const invalid = passwordError(newPassword) ?? (newPassword === String(body.password) ? 'A senha nova precisa ser diferente da provisória.' : undefined);
  if (invalid) {
    sendJson(res, 400, { error: invalid });
    return undefined;
  }
  return { user, newPassword };
}

function nameFromEmail(email: string): string {
  return email.split('@')[0] ?? email;
}

/** `true` = rota tratada (qualquer status); `false` = não é rota de auth. */
export async function handleAuthRoute(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith('/api/auth/')) return false;

  if (req.method === 'GET' && pathname === '/api/auth/status') {
    const session = await getLiveSession(req);
    const user = session ? await findUserById(session.userId) : undefined;
    return sendJson(res, 200, { configured: await hasUsers(), authenticated: Boolean(user), id: user?.id, name: user?.name, role: user?.role });
  }

  // Só sem nenhum usuário cadastrado: cria o primeiro Master. Depois disso usuários só pela tela de Usuários.
  if (req.method === 'POST' && (pathname === '/api/auth/setup' || pathname === '/api/auth/setup/confirm')) {
    if (await hasUsers()) return sendJson(res, 403, { error: 'Já existe usuário cadastrado: peça acesso a um Master.' });
    const body = await readJsonBody(req);
    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim();
    const password = String(body.password ?? '');
    if (!name || !email || !password) return sendJson(res, 400, { error: 'Nome, e-mail e senha são obrigatórios.' });
    const invalid = passwordError(password);
    if (invalid) return sendJson(res, 400, { error: invalid });
    if (pathname === '/api/auth/setup') return sendJson(res, 200, { totpSecret: generateTotpSecret() });

    const totpSecret = String(body.totpSecret ?? '');
    const step = confirmNewTotp(totpSecret, String(body.code ?? ''));
    if (step === undefined) return sendJson(res, 400, INVALID_TOTP);
    const user = { id: randomBytes(8).toString('hex'), name, email, passwordHash: await hashPassword(password), totpSecret: encryptSecret(totpSecret), role: 'master' as const, mustSetup: false };
    await insertUser(user, step);
    setSessionCookie(res, await createSession(user));
    return sendJson(res, 200, { ok: true });
  }

  // Fase 1 do login: só e-mail/senha, sem sessão — a fase 2 (/api/auth/login) inclui o código.
  if (req.method === 'POST' && pathname === '/api/auth/login/password') {
    const body = await readJsonBody(req);
    const user = await checkCredentials(req, res, String(body.email ?? '').trim(), String(body.password ?? ''));
    if (!user) return true;
    return sendJson(res, 200, { ok: true, setupRequired: user.mustSetup });
  }

  if (req.method === 'POST' && pathname === '/api/auth/first-access') {
    if (!(await parseFirstAccess(req, res, await readJsonBody(req)))) return true;
    return sendJson(res, 200, { totpSecret: generateTotpSecret() });
  }

  if (req.method === 'POST' && pathname === '/api/auth/first-access/confirm') {
    const body = await readJsonBody(req);
    const access = await parseFirstAccess(req, res, body);
    if (!access) return true;
    const totpSecret = String(body.totpSecret ?? '');
    const step = confirmNewTotp(totpSecret, String(body.code ?? ''));
    if (step === undefined) return sendJson(res, 400, INVALID_TOTP);
    const [result] = await (await db()).query<ResultSetHeader>(
      'UPDATE users SET password_hash = ?, totp_secret = ?, totp_last_step = ?, must_setup = FALSE WHERE id = ? AND must_setup = TRUE',
      [await hashPassword(access.newPassword), encryptSecret(totpSecret), step, access.user.id],
    );
    if (!result.affectedRows) return sendJson(res, 409, { error: 'Esse usuário já concluiu o primeiro acesso.' });
    await clearLoginAttempts(loginLimitKey(req, access.user.email));
    setSessionCookie(res, await createSession(access.user));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJsonBody(req);
    const email = String(body.email ?? '').trim();
    const password = String(body.password ?? '');
    const code = String(body.code ?? '');
    const limitKey = loginLimitKey(req, email);
    if (!(await allowLoginAttempt(limitKey))) return sendJson(res, 429, TOO_MANY_ATTEMPTS);
    const found = await findUserByEmail(email);
    const user = found && !found.mustSetup ? found : undefined;
    const passwordOk = await verifyPassword(password, await passwordHashOrDummy(user));
    const step = user && passwordOk ? matchTotpStep(decryptSecret(user.totpSecret), code) : undefined;
    if (!user || step === undefined || !(await claimTotpStep(user.id, step))) {
      return sendJson(res, 401, { error: 'E-mail, senha ou código inválidos.' });
    }
    await clearLoginAttempts(limitKey);
    if (needsRehash(user.passwordHash)) {
      await (await db()).query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), user.id]);
    }
    if (!isEncryptedSecret(user.totpSecret)) {
      await (await db()).query('UPDATE users SET totp_secret = ? WHERE id = ?', [encryptSecret(user.totpSecret), user.id]);
    }
    setSessionCookie(res, await createSession(user));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const token = getSessionToken(req);
    if (token) await endSession(token);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Rota de auth desconhecida.' });
}

async function listUsers(): Promise<UserSummary[]> {
  const [rows] = await (await db()).query<RowDataPacket[]>('SELECT id, name, email, role, must_setup AS mustSetup, created_at AS createdAt FROM users ORDER BY created_at');
  return rows.map((row) => {
    const createdAt = new Date(row.createdAt);
    const pending = Boolean(row.mustSetup);
    return { id: row.id, name: row.name, email: row.email, role: row.role, pending, expired: isPendingExpired(pending, createdAt), createdAt: createdAt.toISOString() };
  });
}

/** Chamador já garantiu `requireAuth`. Só Master gerencia usuários. */
export async function handleUsersRoute(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const match = /^\/api\/users(?:\/([0-9a-f]+))?$/.exec(pathname);
  if (!match) return false;
  const session = (await getLiveSession(req))!;
  if (session.role !== 'master') return sendJson(res, 403, { error: 'Só usuários Master gerenciam usuários.' });
  const targetId = match[1];

  if (req.method === 'GET' && !targetId) return sendJson(res, 200, await listUsers());

  if (req.method === 'POST' && !targetId) {
    const body = await readJsonBody(req);
    const email = String(body.email ?? '').trim();
    const password = String(body.password ?? '');
    const role = body.role;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'Informe um e-mail válido.' });
    if (!USER_ROLES.includes(role as UserRole)) return sendJson(res, 400, { error: 'Escolha o nível: Master ou Tester.' });
    const invalid = passwordError(password);
    if (invalid) return sendJson(res, 400, { error: invalid });
    if (await findUserByEmail(email)) return sendJson(res, 409, EMAIL_TAKEN);
    await insertUser({
      id: randomBytes(8).toString('hex'),
      name: nameFromEmail(email),
      email,
      passwordHash: await hashPassword(password),
      totpSecret: '',
      role: role as UserRole,
      mustSetup: true,
    });
    return sendJson(res, 200, await listUsers());
  }

  if (req.method === 'DELETE' && targetId) {
    if (targetId === session.userId) return sendJson(res, 400, { error: 'Você não pode excluir o próprio usuário.' });
    const target = await findUserById(targetId);
    if (!target) return sendJson(res, 404, { error: 'Usuário não encontrado.' });
    await (await db()).query('DELETE FROM users WHERE id = ?', [targetId]);
    await endUserSessions(targetId);
    return sendJson(res, 200, await listUsers());
  }

  return sendJson(res, 405, { error: 'Método não suportado.' });
}
