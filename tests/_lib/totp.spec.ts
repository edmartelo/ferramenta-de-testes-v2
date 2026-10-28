import { test, expect } from '@playwright/test';
import { generateTotpCode, generateTotpSecret, isValidTotpSecret, matchTotpStep } from '../../src/lib/totp';

test.describe('generateTotpCode', () => {
  const secret = 'JBSWY3DPEHPK3PXP';

  // Início exato de uma janela de 30s, pra não cruzar o limite sem querer.
  const windowStart = 56_666_666 * 30_000;

  test('gera código numérico com o número de dígitos pedido', () => {
    const code = generateTotpCode(secret, { at: windowStart });
    expect(code).toMatch(/^\d{6}$/);

    const code8 = generateTotpCode(secret, { digits: 8, at: windowStart });
    expect(code8).toMatch(/^\d{8}$/);
  });

  test('mesma janela de tempo (30s) → mesmo código', () => {
    const a = generateTotpCode(secret, { at: windowStart });
    const b = generateTotpCode(secret, { at: windowStart + 29_000 });
    expect(a).toBe(b);
  });

  test('janelas de tempo diferentes → código muda', () => {
    const a = generateTotpCode(secret, { at: windowStart });
    const b = generateTotpCode(secret, { at: windowStart + 30_000 });
    expect(a).not.toBe(b);
  });

  test('chave com caractere inválido (fora do alfabeto base32) lança erro', () => {
    expect(() => generateTotpCode('chave-com-1-e-0-invalidos!')).toThrow();
  });
});

test.describe('matchTotpStep', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const step = 56_666_666;
  const at = step * 30_000 + 10_000;
  const codeAt = (s: number) => generateTotpCode(secret, { at: s * 30_000 });

  test('código da janela atual devolve o passo dela', () => {
    expect(matchTotpStep(secret, codeAt(step), { at })).toBe(step);
  });

  test('aceita a janela anterior e a seguinte (relógio dessincronizado)', () => {
    expect(matchTotpStep(secret, codeAt(step - 1), { at })).toBe(step - 1);
    expect(matchTotpStep(secret, codeAt(step + 1), { at })).toBe(step + 1);
  });

  test('recusa código de duas janelas atrás e formato inválido', () => {
    expect(matchTotpStep(secret, codeAt(step - 2), { at })).toBeUndefined();
    expect(matchTotpStep(secret, '12345', { at })).toBeUndefined();
    expect(matchTotpStep(secret, 'abcdef', { at })).toBeUndefined();
  });
});

test.describe('isValidTotpSecret', () => {
  test('aceita o segredo gerado aqui', () => {
    expect(isValidTotpSecret(generateTotpSecret())).toBe(true);
  });

  test('recusa chave vazia, só padding, curta ou fora do base32', () => {
    for (const secret of ['', '=', '    ', 'JBSWY3DPEHPK3PXP', 'jbswy3dpehpk3pxpjbswy3dpehpk3pxp', `${'A'.repeat(31)}1`]) {
      expect(isValidTotpSecret(secret), secret).toBe(false);
    }
  });
});
