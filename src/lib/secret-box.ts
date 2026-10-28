import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { rootEnv } from './root-env.ts';

const KEY_ENV = 'TOTP_ENCRYPTION_KEY';
const PREFIX = 'enc:v1:';

/** 32 bytes em base64, a mesma chave em todas as máquinas: com outra, nenhum código do autenticador bate. */
function encryptionKey(): Buffer {
  const value = rootEnv(KEY_ENV);
  const key = value ? Buffer.from(value, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new Error(`${KEY_ENV} ausente ou inválida: defina 32 bytes em base64 no .env.`);
  return key;
}

export function isEncryptedSecret(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** AES-256-GCM: quem só lê o banco não consegue gerar os códigos do 2FA. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${[iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.')}`;
}

/** Valor sem o prefixo é de antes da cifra e vale como está, até o próximo login cifrá-lo. */
export function decryptSecret(stored: string): string {
  if (!isEncryptedSecret(stored)) return stored;
  const [iv, tag, data] = stored.slice(PREFIX.length).split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !data) throw new Error('Segredo cifrado malformado.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

type SecretFields<T> = { [K in keyof T]: T[K] extends string | undefined ? K : never }[keyof T];

/** Cifra os campos listados que ainda estão em texto puro; os demais passam como estão. */
export function encryptFields<T extends object>(value: T, keys: readonly SecretFields<T>[]): T {
  const copy = { ...value } as Record<keyof T, unknown>;
  for (const key of keys) {
    const field = copy[key];
    if (typeof field === 'string' && field && !isEncryptedSecret(field)) copy[key] = encryptSecret(field);
  }
  return copy as T;
}

export function decryptFields<T extends object>(value: T, keys: readonly SecretFields<T>[]): T {
  const copy = { ...value } as Record<keyof T, unknown>;
  for (const key of keys) {
    const field = copy[key];
    if (typeof field === 'string') copy[key] = decryptSecret(field);
  }
  return copy as T;
}

export function hasPlainField<T extends object>(value: T, keys: readonly SecretFields<T>[]): boolean {
  return keys.some((key) => {
    const field = (value as Record<keyof T, unknown>)[key];
    return typeof field === 'string' && field !== '' && !isEncryptedSecret(field);
  });
}
