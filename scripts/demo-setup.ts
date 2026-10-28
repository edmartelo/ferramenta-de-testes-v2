import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { PROJECT_ROOT } from '../src/lib/paths.ts';
import { rootEnv } from '../src/lib/root-env.ts';
import { DEMO_ACCOUNT_EVENTS_TABLE, DEMO_ACCOUNTS_TABLE, DEMO_ADDED_COLUMNS, DEMO_PASSWORD_NULLABLE, DEMO_DATABASE, DEMO_DB_USER, DEMO_UPDATABLE_COLUMNS } from '../server/demo/schema.ts';

/**
 * Cria, com a credencial admin do `.env`, o banco da demo, a tabela e o usuário `demo_app` com privilégio mínimo,
 * e grava `.env.demo` (gitignored). `--print` só mostra o SQL. Rodar de novo mantém a senha do `.env.demo`, a mesma da hospedagem.
 */
const ENV_DEMO_PATH = join(PROJECT_ROOT, '.env.demo');
const printOnly = process.argv.includes('--print');

function required(key: string): string {
  const value = rootEnv(key);
  if (!value) throw new Error(`${key} ausente no .env.`);
  return value;
}

function statements(password: string): { sql: string; values?: string[] }[] {
  const account = `'${DEMO_DB_USER}'@'%'`;
  const table = `${DEMO_DATABASE}.demo_accounts`;
  return [
    { sql: `CREATE DATABASE IF NOT EXISTS ${DEMO_DATABASE} CHARACTER SET utf8mb4` },
    { sql: DEMO_ACCOUNTS_TABLE },
    { sql: DEMO_ACCOUNT_EVENTS_TABLE },
    { sql: `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ? REQUIRE SSL`, values: [password] },
    { sql: `ALTER USER ${account} IDENTIFIED BY ? REQUIRE SSL`, values: [password] },
    { sql: `GRANT SELECT, INSERT, DELETE ON ${table} TO ${account}` },
    { sql: `GRANT UPDATE (${DEMO_UPDATABLE_COLUMNS.join(', ')}) ON ${table} TO ${account}` },
    // DELETE com `WHERE account_id` exige SELECT nessa coluna; só ela, o demo_app continua sem ler o histórico.
    { sql: `GRANT INSERT, DELETE, SELECT (account_id) ON ${DEMO_DATABASE}.demo_account_events TO ${account}` },
  ];
}

async function addMissingColumns(connection: mysql.Connection): Promise<void> {
  for (const { table, column, definition } of DEMO_ADDED_COLUMNS) {
    const [found] = await connection.query('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [DEMO_DATABASE, table, column]);
    if (!(found as unknown[]).length) await connection.query(`ALTER TABLE ${DEMO_DATABASE}.${table} ADD COLUMN ${column} ${definition}`);
  }
  await connection.query(DEMO_PASSWORD_NULLABLE);
}

if (printOnly) {
  for (const { sql } of statements('<senha gerada>')) console.log(`${sql.replace('?', "'<senha gerada>'")};\n`);
  process.exit(0);
}

const existingEnv = existsSync(ENV_DEMO_PATH) ? readFileSync(ENV_DEMO_PATH, 'utf-8') : '';
const password = existingEnv.match(/^DEMO_DB_PASSWORD=(.+)$/m)?.[1] ?? randomBytes(24).toString('base64url');
const connection = await mysql.createConnection({
  host: required('SHARED_DB_HOST'),
  port: Number(rootEnv('SHARED_DB_PORT') ?? 3306),
  user: required('SHARED_DB_USER'),
  password: required('SHARED_DB_PASSWORD'),
  ssl: { ca: readFileSync(join(PROJECT_ROOT, required('SHARED_DB_SSL_CA')), 'utf-8') },
});
try {
  for (const { sql, values } of statements(password)) {
    // Antes do usuário e dos GRANTs: o GRANT de UPDATE por coluna precisa das colunas novas.
    if (sql.startsWith('CREATE USER')) await addMissingColumns(connection);
    await connection.query(sql, values);
  }
  const [rows] = await connection.query(`SHOW GRANTS FOR '${DEMO_DB_USER}'@'%'`);
  const grants = (rows as Record<string, string>[]).map((row) => String(Object.values(row)[0]));
  console.log('Permissões do demo_app:');
  for (const grant of grants) console.log(`  ${grant}`);
  // O Aiven não deixa `REVOKE ALL`: qualquer permissão além das da tabela da demo para o setup.
  const unexpected = grants.filter((grant) => !/^GRANT USAGE ON \*\.\* TO /.test(grant) && !/ON ferramenta_demo\.demo_account(s|_events) TO/.test(grant.replace(/[`"]/g, '')));
  if (unexpected.length) throw new Error(`demo_app tem permissões a mais, remova antes de usar:\n${unexpected.join('\n')}`);
} finally {
  await connection.end();
}

const sessionSecret = existingEnv.match(/^DEMO_SESSION_SECRET=(.+)$/m)?.[1] ?? randomBytes(32).toString('base64url');
writeFileSync(
  ENV_DEMO_PATH,
  [
    '# Gerado por `npm run demo:setup`. Na hospedagem, cadastre os mesmos nomes como variáveis de ambiente;',
    '# lá DEMO_DB_SSL_CA recebe o conteúdo do certificado, não o caminho.',
    `DEMO_DB_HOST=${required('SHARED_DB_HOST')}`,
    `DEMO_DB_PORT=${rootEnv('SHARED_DB_PORT') ?? 3306}`,
    `DEMO_DB_USER=${DEMO_DB_USER}`,
    `DEMO_DB_PASSWORD=${password}`,
    `DEMO_DB_NAME=${DEMO_DATABASE}`,
    `DEMO_DB_SSL_CA=${join(PROJECT_ROOT, required('SHARED_DB_SSL_CA')).replace(/\\/g, '/')}`,
    `DEMO_SESSION_SECRET=${sessionSecret}`,
    '',
  ].join('\n'),
);
console.log(`.env.demo gravado em ${ENV_DEMO_PATH}.`);
