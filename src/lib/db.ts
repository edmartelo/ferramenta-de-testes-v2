import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import awsCaBundle from 'aws-ssl-profiles';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { readJsonFile } from './json-file.ts';
import { PROJECT_ROOT, PROMOTIONS_ROOT, promotionDir } from './paths.ts';
import { rootEnv } from './root-env.ts';

/** O restart do Vite reimporta este módulo: pool novo a cada restart deixaria as conexões do anterior abertas no banco. Trocar `SHARED_DB_*` pede reiniciar o `npm run dev`. */
const poolCache = globalThis as unknown as { __ferramentaDbPool?: Pool };

/** CA do provedor: o conteúdo do certificado, o caminho dele, relativo à raiz ou absoluto, ou `Amazon RDS`, os CAs da AWS que vêm com o mysql2. */
function sharedSsl(value: string | undefined): { ca: string | string[] } | undefined {
  if (!value) return undefined;
  // Colado no painel, o PEM às vezes chega com `\n` literal no lugar das quebras de linha.
  if (value.includes('-----BEGIN CERTIFICATE-----')) return { ca: value.replace(/\\n/g, '\n') };
  if (value === 'Amazon RDS') return { ca: awsCaBundle.ca };
  const fullPath = resolve(PROJECT_ROOT, value);
  if (!existsSync(fullPath)) throw new Error(`SHARED_DB_SSL_CA aponta pra um arquivo que não existe: ${fullPath}`);
  return { ca: readFileSync(fullPath, 'utf-8') };
}

const sharedHost = rootEnv('SHARED_DB_HOST');
const pool: Pool = (poolCache.__ferramentaDbPool ??= mysql.createPool({
  host: sharedHost,
  port: Number(rootEnv('SHARED_DB_PORT') ?? 3306),
  user: rootEnv('SHARED_DB_USER'),
  password: rootEnv('SHARED_DB_PASSWORD'),
  database: rootEnv('SHARED_DB_NAME'),
  ssl: sharedSsl(rootEnv('SHARED_DB_SSL_CA')),
  // O banco aceita poucas conexões e cada máquina tem o próprio pool.
  connectionLimit: 5,
  charset: 'utf8mb4',
}));

const SETTINGS_TABLE = `CREATE TABLE IF NOT EXISTS settings (
    name VARCHAR(64) PRIMARY KEY,
    value TEXT NOT NULL
  )`;

/** Agendamento de Recorrências, id do executor, atendimentos lidos e caches do Ollama ficam em arquivos desta máquina, não aqui. */
const SCHEMA = [
  SETTINGS_TABLE,
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(32) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    totp_secret VARCHAR(255) NOT NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'tester',
    must_setup BOOLEAN NOT NULL DEFAULT FALSE,
    totp_last_step BIGINT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id VARCHAR(32) NOT NULL,
    expires_at BIGINT NOT NULL,
    INDEX (user_id),
    INDEX (expires_at)
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    limit_key CHAR(64) PRIMARY KEY,
    attempts INT NOT NULL,
    reset_at BIGINT NOT NULL,
    INDEX (reset_at)
  )`,
  `CREATE TABLE IF NOT EXISTS test_runs (
    promotion_id VARCHAR(128) NOT NULL,
    env VARCHAR(16) NOT NULL,
    run_group VARCHAR(64) NOT NULL,
    total INT NOT NULL DEFAULT 0,
    results JSON NOT NULL,
    manual_checks JSON NOT NULL,
    error TEXT NULL,
    started_at BIGINT NOT NULL,
    finished_at BIGINT NULL,
    PRIMARY KEY (promotion_id, env)
  )`,
  `CREATE TABLE IF NOT EXISTS promotions (
    id VARCHAR(128) PRIMARY KEY,
    data JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  // Correções do Aprendizado: já gravadas com os dados pessoais mascarados.
  `CREATE TABLE IF NOT EXISTS atendimento_labels (
    promotion_name VARCHAR(255) NOT NULL,
    atendimento_id VARCHAR(64) NOT NULL,
    assunto TEXT NOT NULL,
    mensagem TEXT NOT NULL,
    severity VARCHAR(16) NOT NULL,
    tema VARCHAR(255) NULL,
    labeled_by VARCHAR(32) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (promotion_name, atendimento_id)
  )`,
  // Só status e contagens: nada de dados de participante.
  `CREATE TABLE IF NOT EXISTS logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    source VARCHAR(32) NOT NULL,
    created_at BIGINT NOT NULL,
    user_id VARCHAR(32) NULL,
    trigger_type VARCHAR(16) NOT NULL,
    action VARCHAR(255) NOT NULL,
    ok BOOLEAN NOT NULL,
    message VARCHAR(1000) NOT NULL,
    details JSON NULL,
    INDEX (source, id),
    INDEX (created_at)
  )`,
];

/** MariaDB guarda JSON como texto; o MySQL local já devolve o objeto. */
export function jsonValue<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

/** Importa os `promotions/<slug>/promotion.json` antigos só enquanto a tabela estiver vazia. */
async function importLegacyPromotionFiles(pool: Pool): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT 1 FROM promotions LIMIT 1');
  if (rows.length || !existsSync(PROMOTIONS_ROOT)) return;
  const values = readdirSync(PROMOTIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .flatMap((entry) => {
      const promotion = readJsonFile<{ id?: string } | undefined>(join(promotionDir(entry.name), 'promotion.json'), undefined);
      return promotion ? [[promotion.id ?? entry.name, JSON.stringify(promotion)]] : [];
    });
  if (values.length) await pool.query('INSERT IGNORE INTO promotions (id, data) VALUES ?', [values]);
}

/** Tabela criada antes dos níveis de acesso: quem já tinha login vira Master e o link de cadastro sai. */
async function addUserRoleColumns(pool: Pool): Promise<void> {
  const [columns] = await pool.query<RowDataPacket[]>(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'",
  );
  if (columns.length) return;
  // DEFAULT 'master' no próprio ALTER: as linhas existentes viram Master de forma atômica, sem UPDATE depois.
  try {
    await pool.query("ALTER TABLE users ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'master', ADD COLUMN must_setup BOOLEAN NOT NULL DEFAULT FALSE");
  } catch (error) {
    if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error;
  }
  await pool.query("ALTER TABLE users ALTER COLUMN role SET DEFAULT 'tester'");
  await pool.query("DELETE FROM settings WHERE name = 'signup_hash'");
}

/** `CREATE TABLE IF NOT EXISTS` não mexe em tabela que já existe: coluna nova entra por aqui. */
async function addColumnIfMissing(pool: Pool, table: string, column: string, definition: string): Promise<void> {
  const [columns] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column],
  );
  if (columns.length) return;
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error;
  }
}

/** Segredo do TOTP cifrado não cabe nos 64 caracteres da coluna original. */
async function widenTotpSecretColumn(pool: Pool): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT CHARACTER_MAXIMUM_LENGTH AS size FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'totp_secret'",
  );
  if (rows[0] && Number(rows[0].size) < 255) await pool.query('ALTER TABLE users MODIFY totp_secret VARCHAR(255) NOT NULL');
}

async function connect(attempts: number): Promise<Pool> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      for (const statement of SCHEMA) await pool.query(statement);
      // Tabelas das Rodadas remotas, que saíram da ferramenta.
      await pool.query('DROP TABLE IF EXISTS remote_runs, remote_executors, remote_promotions');
      await addUserRoleColumns(pool);
      await addColumnIfMissing(pool, 'users', 'totp_last_step', 'BIGINT NULL');
      await widenTotpSecretColumn(pool);
      await importLegacyPromotionFiles(pool);
      return pool;
    } catch (error) {
      if (attempt >= attempts) throw new Error(`Banco MySQL indisponível (${error instanceof Error ? error.message : error}). ${HINT}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

const HINT = 'Confira SHARED_DB_* no .env e se o serviço do banco (Aiven) está ligado.';

/** O banco é acessado pela internet: sem host ou sem SSL nem tenta conectar. */
function configError(): string | undefined {
  if (!sharedHost) return 'SHARED_DB_HOST não definido.';
  if (!rootEnv('SHARED_DB_SSL_CA')) return 'SHARED_DB_SSL_CA não definido: o banco só conecta com SSL.';
  return undefined;
}

let ready: Promise<Pool> | undefined;
/** Depois de uma falha cada requisição tenta uma vez só, sem esperar 20 s. */
let attempts = 10;

/** Banco único (Aiven), de todas as máquinas. Cria as tabelas na primeira chamada; se falhar, a próxima tenta de novo. */
export function db(): Promise<Pool> {
  const error = configError();
  if (error) return Promise.reject(new Error(`${error} ${HINT}`));
  ready ??= connect(attempts).catch((error) => {
    ready = undefined;
    attempts = 1;
    throw error;
  });
  return ready;
}
