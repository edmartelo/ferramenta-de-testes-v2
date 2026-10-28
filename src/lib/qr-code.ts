// Modelo 59 (chars 21-22): Série/SAT(9) + Cupom(6) + Aleatório(6); outros: Série(3) + Cupom(9) + Aleatório(9).
export interface ParsedCouponQrCode {
  raw: string;
  uf: string;
  anoMes: string;
  cnpj: string;
  modelo: string;
  serieSat: string;
  cupom: string;
  aleatorio: string;
  digito: string;
  couponFieldDigits: 6 | 9;
}

const EXPECTED_LENGTH = 44;

export function parseCouponQrCode(code: string): ParsedCouponQrCode {
  if (code.length !== EXPECTED_LENGTH) {
    throw new Error(`Código de cupom deveria ter ${EXPECTED_LENGTH} caracteres, recebeu ${code.length}: "${code}"`);
  }

  const uf = code.substring(0, 2);
  const anoMes = code.substring(2, 6);
  const cnpj = code.substring(6, 20);
  const modelo = code.substring(20, 22);
  const digito = code.substring(43, 44);

  if (modelo === '59') {
    return {
      raw: code, uf, anoMes, cnpj, modelo, digito,
      serieSat: code.substring(22, 31),
      cupom: code.substring(31, 37),
      aleatorio: code.substring(37, 43),
      couponFieldDigits: 6,
    };
  }

  return {
    raw: code, uf, anoMes, cnpj, modelo, digito,
    serieSat: code.substring(22, 25),
    cupom: code.substring(25, 34),
    aleatorio: code.substring(34, 43),
    couponFieldDigits: 9,
  };
}
