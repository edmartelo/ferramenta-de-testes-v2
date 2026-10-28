import type { Page, Response } from '@playwright/test';
import { test, expect } from '../../src/fixtures';
import { formatCpf, randomTestParticipant, randomValidCpf } from '../../src/lib/participant-data';
import { siteRoute } from '../../src/lib/site-url';
import { fieldExists, skipMissingField } from '../../src/lib/form-fields';
import { SIGNED_IN_PARTICIPANT_TRACE, dismissCookieBanner, fieldSelector, setCustomCheckbox, signInParticipant } from '../../src/lib/registration-form';
import { replayHeaders } from '../../src/lib/replay-request';
import { API_TIMEOUT } from '../../src/lib/test-constants';

const OPTIONAL_OPTINS: Array<[id: string, label: string]> = [['msg-whatsapp', 'Opt-in WhatsApp'], ['novidades', 'Opt-in novidades']];

async function openMyData(page: Page, siteUrl: string): Promise<void> {
  const participant = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith('/api/me') && res.ok(), { timeout: API_TIMEOUT });
  await page.goto(siteRoute(siteUrl, 'meus-dados'));
  await participant;
  await dismissCookieBanner(page);
  await expect(page.getByRole('button', { name: /^salvar$/i })).toBeVisible();
  const email = page.locator('#email_confirmation');
  if (await email.count()) await expect(email).not.toHaveValue('');
}

async function save(page: Page): Promise<Response> {
  const response = page.waitForResponse((res) => res.url().includes('participante/atualizar'), { timeout: API_TIMEOUT });
  await page.getByRole('button', { name: /^salvar$/i }).click();
  return response;
}

function comparable(id: string, value: unknown): string {
  const text = String(value ?? '');
  return id.startsWith('email') ? text : text.replace(/\D/g, '');
}

/** Mesmo valor no formato do payload: o front pode mandar a data como `aaaa-mm-dd`. */
function inPayloadFormat(sent: unknown, value: string): string {
  const date = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return date && typeof sent === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sent) ? `${date[3]}-${date[2]}-${date[1]}` : value;
}

/** Front que só envia os campos editáveis não leva os bloqueados: eles vão direto ao backend, que é quem precisa barrar. Devolve o HTTP do envio que levou os valores. */
async function forceSave(page: Page, values: Record<string, string>): Promise<number> {
  const names: Record<string, string> = {};
  for (const [id, value] of Object.entries(values)) {
    const field = page.locator(`#${id}`);
    names[id] = (await field.getAttribute('name')) || id;
    await field.evaluate((element) => element.removeAttribute('disabled'));
    await field.fill(value);
  }
  const response = await save(page);
  const request = response.request();
  const payload: Record<string, unknown> = request.postDataJSON() ?? {};
  const omitted = Object.entries(values).flatMap(([id, value]) => {
    const key = id in payload ? id : (names[id] ?? id);
    const formatted = inPayloadFormat(payload[key], value);
    return comparable(id, payload[key]) === comparable(id, formatted) ? [] : [[key, formatted] as const];
  });
  if (!omitted.length) return response.status();
  const forced = await page.request.post(request.url(), { headers: await replayHeaders(request), data: { ...payload, ...Object.fromEntries(omitted) } });
  return forced.status();
}

test.use({ trace: SIGNED_IN_PARTICIPANT_TRACE });

test.describe('Meus Dados', () => {
  test.describe.configure({ mode: 'default' });

  test.beforeEach(async ({ page, siteUrl, promotion, testEnv }) => {
    test.slow();
    await signInParticipant(page, siteUrl, promotion.id, testEnv);
    await openMyData(page, siteUrl);
  });

  test('campos bloqueados editados via remoção do "disabled" não são gravados pelo backend', async ({ page, siteUrl }) => {
    const other = randomTestParticipant();
    const candidates: Array<[id: string, label: string, value: string]> = [
      ['part_cpf', 'CPF', formatCpf(randomValidCpf())],
      ['part_data_nascimento', 'Data de nascimento', '01/01/1980'],
      ['part_telefone1', 'Celular', other.celular],
      ['email', 'E-mail', other.email],
      ['email_confirmation', 'Confirmar e-mail', other.email],
    ];

    const original: Record<string, string> = {};
    const tampered: Record<string, string> = {};
    for (const [id, label, value] of candidates) {
      const field = page.locator(`#${id}`);
      if (!(await fieldExists(field, label))) continue;
      if (!(await field.isDisabled())) {
        test.info().annotations.push({ type: 'campo-editavel', description: `${label} não está bloqueado no Meus Dados` });
        continue;
      }
      original[id] = await field.inputValue();
      tampered[id] = value;
    }
    test.skip(!Object.keys(original).length, 'nenhum campo bloqueado conhecido existe no formulário');

    expect(await forceSave(page, tampered), 'backend quebrou com o envio adulterado').toBeLessThan(500);
    await openMyData(page, siteUrl);

    const changed: Record<string, string> = {};
    for (const [id, value] of Object.entries(original)) {
      const field = page.locator(`#${id}`);
      if ((await field.inputValue()) !== value) changed[id] = value;
      await expect.soft(field, `#${id} foi alterado`).toHaveValue(value);
    }
    if (!Object.keys(changed).length) return;
    // Em Produção é o participante de teste compartilhado: sem restaurar, as próximas rodadas não logam.
    expect(await forceSave(page, original), 'não restaurou os campos alterados do participante de teste').toBeLessThan(400);
    await openMyData(page, siteUrl);
    for (const [id, value] of Object.entries(changed)) await expect(page.locator(`#${id}`), `#${id} não voltou ao valor original`).toHaveValue(value);
  });

  test('opt-ins opcionais alterados continuam salvos ao sair e voltar', async ({ page, siteUrl }) => {
    const expected: Record<string, boolean> = {};
    for (const [id, label] of OPTIONAL_OPTINS) {
      const checkbox = page.locator(fieldSelector(id)).first();
      if (!(await fieldExists(checkbox, label))) continue;
      expected[id] = !(await checkbox.isChecked());
      await setCustomCheckbox(page, id, expected[id]);
    }
    if (!Object.keys(expected).length) skipMissingField('formulário sem opt-ins opcionais');

    await save(page);
    await expect(page.getByText('Dados alterados com sucesso!')).toBeVisible({ timeout: API_TIMEOUT });

    await page.goto(siteUrl);
    await openMyData(page, siteUrl);

    for (const [id, checked] of Object.entries(expected)) {
      await expect.soft(page.locator(fieldSelector(id)).first(), `#${id} não manteve o valor salvo`).toBeChecked({ checked });
    }
  });
});
