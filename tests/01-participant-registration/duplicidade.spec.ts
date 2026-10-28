import { test, expect } from '../../src/fixtures';
import { randomTestParticipant, type ParticipantData } from '../../src/lib/participant-data';
import { RegistrationForm, disableFrontRecaptcha, registerParticipant } from '../../src/lib/registration-form';
import { API_TIMEOUT, MANUAL_IN_PRODUCTION } from '../../src/lib/test-constants';
import type { MechanicsRules } from '../../promotions/types';

interface DuplicateCase {
  label: string;
  rule: keyof Pick<MechanicsRules, 'allowMultipleCpf' | 'allowMultipleEmail' | 'allowMultiplePhone'>;
  fieldId: string;
  message: string;
  reuse: (first: ParticipantData) => Partial<ParticipantData>;
}

const CASES: DuplicateCase[] = [
  { label: 'CPF', rule: 'allowMultipleCpf', fieldId: 'part_cpf', message: 'O CPF já está sendo utilizado.', reuse: (first) => ({ cpf: first.cpf }) },
  { label: 'e-mail', rule: 'allowMultipleEmail', fieldId: 'email', message: 'O E-mail já está sendo utilizado.', reuse: (first) => ({ email: first.email }) },
  { label: 'celular', rule: 'allowMultiplePhone', fieldId: 'part_telefone1', message: 'O celular já está sendo utilizado.', reuse: (first) => ({ celular: first.celular }) },
];

test.describe('Cadastro de participante › duplicidade (card de Mecânica)', { tag: MANUAL_IN_PRODUCTION }, () => {
  test.beforeEach(async ({ page }) => {
    test.slow();
    await disableFrontRecaptcha(page);
  });

  for (const { label, rule, fieldId, message, reuse } of CASES) {
    test(`segundo cadastro com o mesmo ${label} segue a regra da mecânica`, async ({ page, siteUrl, promotion }) => {
      await (await RegistrationForm.open(page, siteUrl)).requireField(fieldId, label);
      const allowed = promotion.mechanicsRules?.[rule] ?? false;
      const first = randomTestParticipant();
      await registerParticipant(page, siteUrl, first);

      const second = { ...randomTestParticipant(), ...reuse(first) };
      if (allowed) {
        await registerParticipant(page, siteUrl, second);
        return;
      }

      const form = await RegistrationForm.fillAndSubmit(page, siteUrl, second);
      await expect(form.error(fieldId)).toContainText(message, { timeout: API_TIMEOUT });
      await expect(page).toHaveURL(/\/cadastro$/);
    });
  }
});
