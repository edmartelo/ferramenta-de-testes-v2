import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EnvKey } from '../../promotions/types.ts';
import { readJsonFile, writeJsonFile } from './json-file.ts';
import { promotionDir } from './paths.ts';
import { decryptFields, encryptFields, hasPlainField } from './secret-box.ts';

export interface PromotionCredentials {
  adminPanelUser?: string;
  adminPanelPassword?: string;
  adminPanelTotpSecret?: string;
  /** Só dígitos. */
  testParticipantCpf?: string;
  testParticipantPassword?: string;
  recaptchaSiteKey?: string;
  recaptchaSecretKey?: string;
}

export type PromotionCredentialsFile = Partial<Record<EnvKey, PromotionCredentials>>;

function credentialsPath(id: string): string {
  return join(promotionDir(id), '.credentials.json');
}

/** Cifrados no arquivo com a `TOTP_ENCRYPTION_KEY`: senha e chave do autenticador juntas abririam o painel de produção. */
const SECRET_FIELDS = ['adminPanelPassword', 'adminPanelTotpSecret', 'testParticipantPassword', 'recaptchaSecretKey'] as const;

function mapEnvs(all: PromotionCredentialsFile, map: (credentials: PromotionCredentials) => PromotionCredentials): PromotionCredentialsFile {
  return Object.fromEntries(Object.entries(all).map(([env, credentials]) => [env, map(credentials)]));
}

function readStoredCredentials(id: string): PromotionCredentialsFile {
  return readJsonFile<PromotionCredentialsFile>(credentialsPath(id), {});
}

function writeStoredCredentials(id: string, all: PromotionCredentialsFile): void {
  const path = credentialsPath(id);
  // Promoção criada em outra máquina ainda não tem pasta nesta.
  mkdirSync(dirname(path), { recursive: true });
  writeJsonFile(path, mapEnvs(all, (credentials) => encryptFields(credentials, SECRET_FIELDS)));
}

export function readPromotionCredentials(id: string): PromotionCredentialsFile {
  return mapEnvs(readStoredCredentials(id), (credentials) => decryptFields(credentials, SECRET_FIELDS));
}

export function writePromotionCredentials(id: string, env: EnvKey, updates: PromotionCredentials): void {
  const all = readStoredCredentials(id);
  all[env] = { ...all[env], ...updates };
  writeStoredCredentials(id, all);
}

/** Arquivo gravado antes da cifra: regrava cifrado. Só o servidor chama, os processos do Playwright só leem. */
export function encryptStoredCredentials(id: string): void {
  const all = readStoredCredentials(id);
  if (Object.values(all).some((credentials) => credentials && hasPlainField(credentials, SECRET_FIELDS))) writeStoredCredentials(id, all);
}

/** Com as duas chaves no Dev o projeto local sobe com reCAPTCHA ligado; só as chaves de teste do Google passam sem desafio. */
export function devRecaptchaKeys(promotionId: string): { siteKey: string; secretKey: string } | undefined {
  const { recaptchaSiteKey, recaptchaSecretKey } = readPromotionCredentials(promotionId).dev ?? {};
  return recaptchaSiteKey && recaptchaSecretKey ? { siteKey: recaptchaSiteKey, secretKey: recaptchaSecretKey } : undefined;
}

export function adminPanelSessionPath(promotionId: string, envKey: EnvKey): string {
  return join(promotionDir(promotionId), `.painel-session-${envKey}.json`);
}

/** Não valida expiração: quem cai de volta em /login precisa reautenticar. */
export function existingAdminPanelSessionPath(promotionId: string, envKey: EnvKey): string | undefined {
  const path = adminPanelSessionPath(promotionId, envKey);
  return existsSync(path) ? path : undefined;
}
