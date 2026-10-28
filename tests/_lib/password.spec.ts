import { randomBytes, scryptSync } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { hashPassword, needsRehash, verifyPassword } from '../../src/lib/password';

test.describe('hashPassword / verifyPassword', () => {
  test('confere a senha certa e recusa a errada', async () => {
    const stored = await hashPassword('senha-de-teste-1');
    expect(stored).toMatch(/^scrypt\$131072\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(await verifyPassword('senha-de-teste-1', stored)).toBe(true);
    expect(await verifyPassword('senha-de-teste-2', stored)).toBe(false);
    expect(needsRehash(stored)).toBe(false);
  });

  test('hash antigo (sal:hash, custo padrão do Node) continua valendo e pede rehash', async () => {
    const salt = randomBytes(16);
    const legacy = `${salt.toString('hex')}:${scryptSync('senha-antiga', salt, 64).toString('hex')}`;
    expect(await verifyPassword('senha-antiga', legacy)).toBe(true);
    expect(await verifyPassword('outra', legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
  });

  test('hash malformado ou com custo absurdo é recusado sem lançar erro', async () => {
    for (const stored of ['', 'abc', 'scrypt$x$00$00', 'scrypt$1073741824$00$00']) {
      expect(await verifyPassword('qualquer', stored), stored).toBe(false);
    }
  });
});
