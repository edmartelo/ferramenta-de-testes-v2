import type { EnvKey } from '../promotions/types.ts';

export interface ManualTest {
  id: string;
  label: string;
}

export interface TestGroup {
  id: string;
  label: string;
  /** Pasta em `tests/`; o prefixo numérico define a ordem (Playwright ordena por caminho). */
  folder: string;
  manualTests?: ManualTest[];
}

export const TEST_GROUPS: TestGroup[] = [
  {
    id: 'participant-registration',
    label: 'Cad Participante',
    folder: '01-participant-registration',
    manualTests: [
      { id: 'underage', label: 'Cadastro com menor de 18 anos exibe erro de idade mínima' },
      { id: 'duplicate-cpf', label: 'Segundo cadastro com o mesmo CPF segue a regra da mecânica' },
      { id: 'duplicate-email', label: 'Segundo cadastro com o mesmo e-mail segue a regra da mecânica' },
      { id: 'duplicate-phone', label: 'Segundo cadastro com o mesmo celular segue a regra da mecânica' },
    ],
  },
  {
    id: 'coupon-registration',
    label: 'Cad Cupom',
    folder: '02-coupon-registration',
    manualTests: [
      { id: 'missing-image', label: 'Envio sem imagem do cupom exibe modal "Imagem do cupom é obrigatória." (se o formulário tiver upload de imagem)' },
      { id: 'below-min-value', label: 'Envio com valor abaixo do mínimo exibe modal "Valor mínimo do cupom é R$ xx" (valor da mecânica)' },
    ],
  },
  { id: 'my-data', label: 'Meus Dados', folder: '03-my-data' },
];

export interface MassRegistrationGroup {
  id: string;
  label: string;
  spec: string;
}

/** Specs em `tests/_*`: nunca entram no "Rodar tudo". */
export const MASS_REGISTRATION_GROUPS: MassRegistrationGroup[] = [
  { id: 'mass-participant', label: 'Cad Participante', spec: 'tests/_mass-registration/participantes.spec.ts' },
  { id: 'mass-coupon', label: 'Cad Cupom', spec: 'tests/_mass-registration/cupons.spec.ts' },
];

/** Ambiente fora daqui não tem cadastro em massa. */
export const MASS_REGISTRATION_LIMITS: Partial<Record<EnvKey, number>> = { dev: 20, staging: 5 };
