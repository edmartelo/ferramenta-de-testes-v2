import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { decryptFields, decryptSecret, encryptFields, encryptSecret, hasPlainField, isEncryptedSecret } from '../../src/lib/secret-box';

test.describe('encryptSecret / decryptSecret', () => {
  const original = process.env.TOTP_ENCRYPTION_KEY;

  test.beforeEach(() => {
    process.env.TOTP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  });

  test.afterEach(() => {
    if (original === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
    else process.env.TOTP_ENCRYPTION_KEY = original;
  });

  test('cifra e decifra, com IV novo a cada vez e cabendo em VARCHAR(255)', () => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const a = encryptSecret(secret);
    const b = encryptSecret(secret);
    expect(isEncryptedSecret(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(255);
    expect(decryptSecret(a)).toBe(secret);
  });

  test('valor antigo, sem prefixo, passa como está', () => {
    expect(decryptSecret('JBSWY3DPEHPK3PXP')).toBe('JBSWY3DPEHPK3PXP');
    expect(decryptSecret('')).toBe('');
  });

  test('valor adulterado ou chave trocada não decifra', () => {
    const stored = encryptSecret('JBSWY3DPEHPK3PXP');
    const parts = stored.split('.');
    const data = parts.pop()!;
    const tampered = [...parts, `${data[0] === 'A' ? 'B' : 'A'}${data.slice(1)}`].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
    process.env.TOTP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(() => decryptSecret(stored)).toThrow();
  });

  test('sem chave, ou com tamanho errado, falha com mensagem clara', () => {
    // Vazio, não `delete`: sem a variável o `rootEnv` cairia na chave do `.env` da máquina.
    process.env.TOTP_ENCRYPTION_KEY = '';
    expect(() => encryptSecret('x')).toThrow(/TOTP_ENCRYPTION_KEY/);
    process.env.TOTP_ENCRYPTION_KEY = randomBytes(16).toString('base64');
    expect(() => encryptSecret('x')).toThrow(/TOTP_ENCRYPTION_KEY/);
  });

  test('encryptFields cifra só os campos listados, sem cifrar duas vezes', () => {
    const plain = { user: 'admin@exemplo.com', password: 'senha', totp: 'JBSWY3DPEHPK3PXP', empty: '' };
    const keys = ['password', 'totp', 'empty'] as const;
    expect(hasPlainField(plain, keys)).toBe(true);
    const sealed = encryptFields(plain, keys);
    expect(sealed.user).toBe(plain.user);
    expect(sealed.empty).toBe('');
    expect(isEncryptedSecret(sealed.password)).toBe(true);
    expect(hasPlainField(sealed, keys)).toBe(false);
    expect(encryptFields(sealed, keys)).toEqual(sealed);
    expect(decryptFields(sealed, keys)).toEqual(plain);
  });
});
