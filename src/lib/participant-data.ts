function cpfCheckDigit(base: string): number {
  let sum = 0;
  let weight = base.length + 1;
  for (const digit of base) {
    sum += Number(digit) * weight;
    weight -= 1;
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

export function randomValidCpf(): string {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join('');
  const d1 = cpfCheckDigit(base);
  const d2 = cpfCheckDigit(base + d1);
  return `${base}${d1}${d2}`;
}

function cnpjCheckDigit(base: string): number {
  const weights = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = [...base].reduce((total, digit, i) => total + Number(digit) * (weights[i] ?? 0), 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

export function randomValidCnpj(): string {
  const base = `${Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('')}0001`;
  const d1 = cnpjCheckDigit(base);
  return `${base}${d1}${cnpjCheckDigit(base + d1)}`;
}

export function formatCpf(cpf: string): string {
  return cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
}

export interface ParticipantData {
  cpf: string;
  nome: string;
  sobrenome: string;
  dataNascimento: string;
  celular: string;
  cep: string;
  numero: string;
  email: string;
  senha: string;
  optinWhats?: boolean;
  optinNoticias?: boolean;
}

export function randomTestParticipant(): ParticipantData {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9);
  return {
    cpf: randomValidCpf(),
    nome: 'Fulano',
    sobrenome: 'Teste AUTO',
    dataNascimento: '06/12/1990',
    celular: `(11) 9${suffix.slice(0, 4)}-${suffix.slice(4, 8)}`,
    cep: '06394-050',
    numero: '445',
    email: `qa.teste+${suffix}@exemplo.com.br`,
    senha: 'Em1234',
    optinWhats: false,
    optinNoticias: false,
  };
}
