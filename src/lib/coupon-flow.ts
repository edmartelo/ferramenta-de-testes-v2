import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { MechanicsRules } from '../../promotions/types';
import { randomValidCnpj } from './participant-data';
import { checkRecaptcha, submitConfirmingData } from './registration-form';
import { siteRoute } from './site-url';
import { API_TIMEOUT } from './test-constants';

export function brl(value: number): string {
  return value.toFixed(2).replace('.', ',');
}

/** Use sempre esta foto de cupom real: o backend extrai os dados da imagem. */
export const TEST_COUPON_IMAGE = fileURLToPath(new URL('../../tests/fixtures/cupom-teste.png', import.meta.url));

/** Limite de cupons/dia por participante: cada envio válido precisa de um participante novo. */
export class CouponForm {
  readonly value: Locator;
  readonly unitValue: Locator;
  readonly fileInput: Locator;
  readonly finishButton: Locator;

  constructor(readonly page: Page) {
    this.value = page.locator('#cupo_valor');
    this.unitValue = page.locator('[id^="cuit_valor"]');
    this.fileInput = page.locator('#fileInput');
    this.finishButton = page.getByRole('button', { name: /^finalizar$/i });
  }

  static async open(page: Page, siteUrl: string): Promise<CouponForm> {
    await page.goto(siteRoute(siteUrl, 'cadastro-cupom'));
    const form = new CouponForm(page);
    // Promoções com escolha da forma de cadastro (QR code, chave de acesso, manual) só mostram o form no manual.
    const manualOption = page.getByRole('button', { name: /cadastro manual/i });
    await expect(form.finishButton.or(manualOption).first()).toBeVisible({ timeout: API_TIMEOUT });
    // Banner de cookies fixo aparece depois e cobre o botão no mobile.
    if (await manualOption.isVisible()) await manualOption.dispatchEvent('click');
    await expect(form.finishButton).toBeVisible({ timeout: API_TIMEOUT });
    // Os campos podem vir de componentes assíncronos que só carregam depois do botão Finalizar.
    await page.waitForLoadState('networkidle', { timeout: API_TIMEOUT });
    return form;
  }

  async attachImage(imagePath: string = TEST_COUPON_IMAGE): Promise<void> {
    await this.fileInput.setInputFiles(imagePath);
  }

  /** Form já renderizado: campo ausente checado na hora; `sequence` reveza o CNPJ de `participatingStoreCnpjs`; `total` vai no valor do cupom ou dividido pelos produtos. */
  async fillValid(rules: MechanicsRules = {}, { sequence = 0, image = true, total = (rules.minCouponValue ?? 0) + 5 }: { sequence?: number; image?: boolean; total?: number } = {}): Promise<void> {
    const present = async (field: Locator) => (await field.count()) > 0;

    const cnpj = this.page.locator('#cupo_cnpj');
    const storeCnpjs = rules.participatingStoreCnpjs ?? [];
    const storeCnpj = storeCnpjs[sequence % storeCnpjs.length];
    if (await present(cnpj)) await cnpj.fill(storeCnpj ?? randomValidCnpj());
    const code = this.page.locator('#cupo_codigo');
    if (await present(code)) await code.fill(String(Math.floor(Math.random() * 900_000) + 100_000));

    const datepicker = this.page.locator('.datepicker');
    if (await present(datepicker)) {
      await datepicker.first().click();
      await this.page.locator('.vdp-datepicker__calendar .cell.day:not(.blank):not(.disabled)').first().click();
    }

    const selects = this.page.locator('.vs__dropdown-toggle');
    for (let index = 0; index < (await selects.count()); index += 1) {
      await selects.nth(index).click();
      const option = this.page.locator('.vs__dropdown-option').first();
      const hasOption = await option.waitFor({ timeout: 2000 }).then(() => true, () => false);
      if (hasOption) await option.click();
      else await this.page.keyboard.press('Escape');
    }
    const quantity = rules.minProductsPerCoupon ?? 1;
    const productQuantity = this.page.locator('[id^="cuit_quantidade"]');
    if (await present(productQuantity)) await productQuantity.first().fill(String(quantity));
    const unitCents = Math.floor((total * 100) / quantity);
    const hasUnitValue = await present(this.unitValue);
    if (hasUnitValue) await this.unitValue.first().fill(brl(unitCents / 100));

    // Com valor unitário, o total é a soma dos itens: o backend pode conferir uma contra o outro.
    if (await this.value.isVisible()) await this.value.fill(brl(hasUnitValue ? (unitCents * quantity) / 100 : total));
    if (image && (await present(this.fileInput))) await this.attachImage();
    await checkRecaptcha(this.page);
  }

  async submit(): Promise<Response> {
    const response = this.page.waitForResponse((res) => res.url().includes('/api/cupom') && res.request().method() === 'POST', { timeout: API_TIMEOUT });
    await submitConfirmingData(this.page, this.finishButton, '/api/cupom');
    return response;
  }
}
