/** Banco próprio da demo, no mesmo servidor MySQL: o usuário da demo não enxerga o banco da ferramenta. */
export const DEMO_DATABASE = 'ferramenta_demo';
export const DEMO_DB_USER = 'demo_app';

/** Únicas colunas que a demo pode alterar depois do cadastro: acesso e "Meus dados". */
export const DEMO_UPDATABLE_COLUMNS = ['name', 'email', 'company', 'password_hash', 'last_login_at', 'login_count', 'failed_logins', 'locked_until', 'totp_secret', 'totp_last_step'] as const;

export const DEMO_ACCOUNTS_TABLE = `CREATE TABLE IF NOT EXISTS ${DEMO_DATABASE}.demo_accounts (
  id CHAR(32) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  company VARCHAR(100) NULL,
  password_hash VARCHAR(255) NULL,
  totp_secret VARCHAR(255) NULL,
  totp_last_step BIGINT NULL,
  privacy_accepted_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP NULL,
  login_count INT NOT NULL DEFAULT 0,
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until BIGINT NULL,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  signup_ip_hmac CHAR(43) NOT NULL,
  INDEX (signup_ip_hmac, created_at),
  INDEX (created_at)
) CHARACTER SET utf8mb4`;

/** Colunas criadas depois da primeira versão das tabelas: `demo:setup` adiciona nas que já existem. */
export const DEMO_ADDED_COLUMNS = [
  { table: 'demo_accounts', column: 'totp_secret', definition: 'VARCHAR(255) NULL AFTER password_hash' },
  { table: 'demo_accounts', column: 'totp_last_step', definition: 'BIGINT NULL AFTER totp_secret' },
  { table: 'demo_account_events', column: 'detail', definition: 'VARCHAR(200) NULL AFTER company' },
] as const;

/** Conta só do Google não tem senha; rodar de novo não muda nada. */
export const DEMO_PASSWORD_NULLABLE = `ALTER TABLE ${DEMO_DATABASE}.demo_accounts MODIFY password_hash VARCHAR(255) NULL`;

export const DEMO_ACCOUNT_EVENTS = ['cadastro', 'edicao', 'exclusao', 'exclusao-master', 'tela', 'acao'] as const;
export type DemoAccountEvent = (typeof DEMO_ACCOUNT_EVENTS)[number];

/** Histórico de cadastro, edição, exclusão, telas visitadas e ações na demo: fica mesmo depois que a conta é apagada. O `demo_app` só insere aqui. */
export const DEMO_ACCOUNT_EVENTS_TABLE = `CREATE TABLE IF NOT EXISTS ${DEMO_DATABASE}.demo_account_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id CHAR(32) NOT NULL,
  event VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(254) NOT NULL,
  company VARCHAR(100) NULL,
  detail VARCHAR(200) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (created_at),
  INDEX (account_id)
) CHARACTER SET utf8mb4`;
