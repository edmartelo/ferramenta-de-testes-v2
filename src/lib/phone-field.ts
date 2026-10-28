import { expect, type Locator } from '@playwright/test';

export const PHONE_FIELD_ID = 'part_telefone1';

const DDD_ERROR = 'DDD inválido. Informe um DDD brasileiro válido';

export interface PhoneCase {
  title: string;
  value: string;
  error?: 'ddd' | 'format';
}

export const MOBILE_CASES: PhoneCase[] = [
  { title: 'celular válido (11 dígitos) é aceito', value: '(11) 91234-5678' },
  { title: 'celular com DDD inválido exibe erro de DDD', value: '(20) 91234-5678', error: 'ddd' },
  { title: 'celular sem 9 após o DDD exibe erro de formato', value: '(11) 81234-5678', error: 'format' },
];

export const LANDLINE_CASES: PhoneCase[] = [
  { title: 'fixo válido (10 dígitos) é aceito', value: '(11) 2345-6789' },
  { title: 'fixo com DDD inválido exibe erro de DDD', value: '(20) 2345-6789', error: 'ddd' },
  { title: 'fixo começando fora de 2-5 após o DDD exibe erro de formato', value: '(11) 6345-6789', error: 'format' },
];

/** `v-mask` decide: só celular reformata 10 dígitos como celular incompleto; celular + fixo aceita os dois. */
export async function acceptsLandline(field: Locator): Promise<boolean> {
  await field.fill('1123456789');
  const accepted = (await field.inputValue()) === '(11) 2345-6789';
  await field.fill('');
  return accepted;
}

export async function expectPhoneCase(field: Locator, error: Locator, phoneCase: PhoneCase, trigger: () => Promise<void>): Promise<void> {
  await field.fill(phoneCase.value);
  await expect(field, `máscara do telefone não aceita "${phoneCase.value}"`).toHaveValue(phoneCase.value);
  await trigger();
  if (!phoneCase.error) {
    await expect(field).toHaveClass(/is-valid/);
    await expect(error).toHaveCount(0);
    return;
  }
  const label = await field.getAttribute('data-vv-as');
  await expect(error).toContainText(phoneCase.error === 'ddd' ? DDD_ERROR : `O campo ${label} possui um formato inválido`);
}
