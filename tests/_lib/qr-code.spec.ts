import { test, expect } from '@playwright/test';
import { parseCouponQrCode } from '../../src/lib/qr-code';

test.describe('parseCouponQrCode', () => {
  test('modelo 59 → campo Cupom com 6 dígitos', () => {
    const code = 'SP' + '2601' + '12345678901234' + '59' + '123456789' + '654321' + '112233' + '9';
    expect(code).toHaveLength(44);

    const parsed = parseCouponQrCode(code);
    expect(parsed.modelo).toBe('59');
    expect(parsed.couponFieldDigits).toBe(6);
    expect(parsed.uf).toBe('SP');
    expect(parsed.anoMes).toBe('2601');
    expect(parsed.cnpj).toBe('12345678901234');
    expect(parsed.serieSat).toBe('123456789');
    expect(parsed.cupom).toBe('654321');
    expect(parsed.aleatorio).toBe('112233');
    expect(parsed.digito).toBe('9');
  });

  test('modelo diferente de 59 → campo Cupom com 9 dígitos', () => {
    const code = 'RJ' + '2603' + '98765432109876' + '65' + '001' + '123456789' + '987654321' + '5';
    expect(code).toHaveLength(44);

    const parsed = parseCouponQrCode(code);
    expect(parsed.modelo).toBe('65');
    expect(parsed.couponFieldDigits).toBe(9);
    expect(parsed.serieSat).toBe('001');
    expect(parsed.cupom).toBe('123456789');
    expect(parsed.aleatorio).toBe('987654321');
    expect(parsed.digito).toBe('5');
  });

  test('lança erro com código de tamanho errado', () => {
    expect(() => parseCouponQrCode('curto-demais')).toThrow();
  });
});
