import { test, expect } from '../../src/fixtures';
import { CouponForm } from '../../src/lib/coupon-flow';
import { formatCpf, type ParticipantData } from '../../src/lib/participant-data';
import { SIGNED_IN_PARTICIPANT_TRACE, disableFrontRecaptcha, registerFreshParticipant } from '../../src/lib/registration-form';
import { API_TIMEOUT } from '../../src/lib/test-constants';
import { massQuantity, recordCreated } from './massa';

test.describe.configure({ mode: 'serial' });
test.use({ trace: SIGNED_IN_PARTICIPANT_TRACE });

test.describe('Cadastro em massa › cupons (todos no mesmo participante novo)', () => {
  let participant: ParticipantData | undefined;
  let session: Record<string, string> = {};

  for (let n = 1; n <= massQuantity(); n += 1) {
    test(`cupom ${n}`, async ({ page, siteUrl, promotion }) => {
      test.slow();
      if (participant) {
        await disableFrontRecaptcha(page);
        await page.addInitScript((saved) => {
          for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
        }, session);
      } else {
        participant = await registerFreshParticipant(page, siteUrl, { stayLoggedIn: true });
        session = await page.evaluate(() => ({ ...localStorage }));
      }

      const form = await CouponForm.open(page, siteUrl);
      await form.fillValid(promotion.mechanicsRules, { sequence: n - 1 });
      const response = await form.submit();
      const failure = response.ok() ? '' : (await response.text()).slice(0, 300);
      expect(response.ok(), `envio do cupom respondeu HTTP ${response.status()}: ${failure}`).toBe(true);
      await expect(page, 'cupom não chegou na tela de sucesso').toHaveURL(/sucesso-cupom/, { timeout: API_TIMEOUT });
      recordCreated(`CPF ${formatCpf(participant.cpf)} · senha ${participant.senha}`);
    });
  }
});
