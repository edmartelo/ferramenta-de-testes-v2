import { createHmac, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(secret: string): Buffer {
  const clean = secret.replace(/\s|=/g, '').toUpperCase();
  let bits = '';
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Caractere inválido na chave TOTP (base32): "${char}"`);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotpCode(secret: string, { digits = 6, periodSeconds = 30, at = Date.now() }: { digits?: number; periodSeconds?: number; at?: number } = {}): string {
  const key = decodeBase32(secret);
  const counter = Math.floor(at / 1000 / periodSeconds);

  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const code = (binary % 10 ** digits).toString().padStart(digits, '0');
  return code;
}

export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let secret = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    secret += BASE32_ALPHABET[parseInt(bits.substring(i, i + 5), 2)];
  }
  return secret;
}

/** Formato que `generateTotpSecret` gera (160 bits): recusa chave vazia ou curta mandada pelo cliente. */
export function isValidTotpSecret(secret: string): boolean {
  return /^[A-Z2-7]{32}$/.test(secret);
}

/** Passo de 30 s em que o código bate, aceitando o anterior/seguinte pra tolerar relógio dessincronizado. */
export function matchTotpStep(secret: string, code: string, { periodSeconds = 30, at = Date.now() }: { periodSeconds?: number; at?: number } = {}): number | undefined {
  const clean = code.trim();
  if (!/^\d{6}$/.test(clean)) return undefined;
  const current = Math.floor(at / 1000 / periodSeconds);
  for (const step of [current, current - 1, current + 1]) {
    if (generateTotpCode(secret, { periodSeconds, at: step * periodSeconds * 1000 }) === clean) return step;
  }
  return undefined;
}
