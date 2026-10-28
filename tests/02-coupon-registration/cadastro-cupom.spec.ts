import type { Request } from '@playwright/test';
import { test, expect } from '../../src/fixtures';
import { CouponForm } from '../../src/lib/coupon-flow';
import { requireField } from '../../src/lib/form-fields';
import { SIGNED_IN_PARTICIPANT_TRACE, disableFrontRecaptcha, messageModal, registerFreshParticipant, signInParticipant, submitConfirmingData } from '../../src/lib/registration-form';
import { replayHeaders } from '../../src/lib/replay-request';
import { siteRoute } from '../../src/lib/site-url';
import { API_TIMEOUT, MANUAL_IN_PRODUCTION } from '../../src/lib/test-constants';

test.use({ trace: SIGNED_IN_PARTICIPANT_TRACE });

test.describe('Cadastro de cupom', { tag: MANUAL_IN_PRODUCTION }, () => {
  test.beforeEach(async ({ page, siteUrl, promotion, testEnv }) => {
    test.slow();
    await disableFrontRecaptcha(page);
    await signInParticipant(page, siteUrl, promotion.id, testEnv);
    await CouponForm.open(page, siteUrl);
  });

  test('envio sem imagem do cupom é barrado', async ({ page, promotion }) => {
    const form = new CouponForm(page);
    await requireField(form.fileInput, 'Imagem do cupom');
    await form.fillValid(promotion.mechanicsRules, { image: false });
    await submitConfirmingData(page, form.finishButton, '/api/cupom');
    await expect(messageModal(page)).toContainText(/Imagem do (cupom|comprovante) é obrigatória\./);
    await expect(page).toHaveURL(/\/cadastro-cupom/);
  });

  test('envio com valor abaixo do mínimo da mecânica é barrado', async ({ page, promotion }) => {
    const minValue = promotion.mechanicsRules?.minCouponValue;
    test.skip(!minValue, 'informe o valor mínimo do cupom no card de Mecânica');

    const form = new CouponForm(page);
    await requireField(form.value.or(form.unitValue).first(), 'Valor do cupom ou valor unitário do produto');
    await form.fillValid(promotion.mechanicsRules, { total: minValue! - 0.01 });
    await form.submit();

    const modal = messageModal(page);
    await expect(modal).toContainText(/Valor mínimo do cupom é\s+R\$/);
    const shown = (await modal.innerText()).match(/R\$\s*([\d.]+(?:,\d+)?)/)?.[1] ?? '';
    expect(Number(shown.replace(/\./g, '').replace(',', '.')), 'valor mínimo do modal difere do card de Mecânica').toBe(minValue);
    await expect(page).toHaveURL(/\/cadastro-cupom/);
  });
});

function withNewCouponCode(body: Buffer | null): Buffer | undefined {
  if (!body) return undefined;
  const code = String(Math.floor(Math.random() * 900_000) + 100_000);
  const text = body
    .toString('latin1')
    .replace(/(name="cupo_codigo"\r\n\r\n)[^\r]*/, `$1${code}`)
    .replace(/("cupo_codigo"\s*:\s*")[^"]*/, `$1${code}`);
  return Buffer.from(text, 'latin1');
}

test.describe('Limite diário de cupons', { tag: MANUAL_IN_PRODUCTION }, () => {
  test('cupom além do limite diário da mecânica é barrado', async ({ page, siteUrl, promotion }) => {
    const limit = promotion.mechanicsRules?.maxCouponsPerDay;
    test.skip(!limit, 'informe o máximo de cupons por dia no card de Mecânica');
    test.setTimeout(120_000 + limit! * 60_000);

    await registerFreshParticipant(page, siteUrl, { stayLoggedIn: true });
    let lastAccepted: Request | undefined;
    for (let n = 1; n <= limit!; n += 1) {
      const form = await CouponForm.open(page, siteUrl);
      await form.fillValid(promotion.mechanicsRules);
      const response = await form.submit();
      lastAccepted = response.request();
      const failure = response.ok() ? '' : (await response.text()).slice(0, 300);
      expect(response.ok(), `cupom ${n} de ${limit} respondeu HTTP ${response.status()}: ${failure}`).toBe(true);
      await expect(page, `cupom ${n} de ${limit} não chegou na tela de sucesso`).toHaveURL(/sucesso-cupom/, { timeout: API_TIMEOUT });
    }

    await page.goto(siteRoute(siteUrl, 'cadastro-cupom'));
    await page.waitForLoadState('networkidle');
    const form = new CouponForm(page);
    if (!(await form.finishButton.isVisible())) {
      // Front escondeu o form: reenvia o último POST aceito, com código novo pra não cair em cupom duplicado, direto ao backend.
      const replay = await page.request.fetch(lastAccepted!.url(), {
        method: 'POST',
        headers: await replayHeaders(lastAccepted!),
        data: withNewCouponCode(lastAccepted!.postDataBuffer()),
      });
      const body = (await replay.text()).slice(0, 300);
      expect(replay.ok(), `backend aceitou o cupom ${limit! + 1} com o limite diário de ${limit} já atingido (form escondido só no front)`).toBe(false);
      expect(body, `backend recusou o cupom ${limit! + 1} por outro motivo: HTTP ${replay.status()} ${body}`).toMatch(/limite/i);
      return;
    }

    await form.fillValid(promotion.mechanicsRules);
    const response = await form.submit();
    expect(response.ok(), `cupom ${limit! + 1} foi aceito com o limite diário de ${limit} já atingido`).toBe(false);
    await expect(messageModal(page)).toContainText(/limite/i);
    await expect(page).toHaveURL(/\/cadastro-cupom/);
  });
});
