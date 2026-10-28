import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** Custo mínimo da OWASP pro scrypt (N = 2^17, r = 8, p = 1): usa ~128 MiB, acima do `maxmem` padrão do Node. */
const SCRYPT_COST = 2 ** 17;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
/** Hash antigo (`sal:hash`) foi gerado com o custo padrão do Node. */
const LEGACY_SCRYPT_COST = 2 ** 14;
const KEY_LENGTH = 64;

function deriveKey(password: string, salt: Buffer, length: number, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, { N: cost, r: 8, p: 1, maxmem: SCRYPT_MAXMEM }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function parseStoredHash(stored: string): { cost: number; salt: Buffer; hash: Buffer } | undefined {
  const [costText, saltHex, hashHex] = stored.startsWith('scrypt$') ? stored.split('$').slice(1) : [String(LEGACY_SCRYPT_COST), ...stored.split(':')];
  const cost = Number(costText);
  if (!saltHex || !hashHex || !Number.isInteger(cost) || cost < 2 || cost > SCRYPT_COST) return undefined;
  return { cost, salt: Buffer.from(saltHex, 'hex'), hash: Buffer.from(hashHex, 'hex') };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await deriveKey(password, salt, KEY_LENGTH, SCRYPT_COST);
  return `scrypt$${SCRYPT_COST}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const actual = await deriveKey(password, parsed.salt, parsed.hash.length, parsed.cost);
  return timingSafeEqual(actual, parsed.hash);
}

/** Hash com custo abaixo do atual: refazer no próximo login certo. */
export function needsRehash(stored: string): boolean {
  return parseStoredHash(stored)?.cost !== SCRYPT_COST;
}
