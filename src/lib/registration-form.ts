import { expect, test, type Locator, type Page } from '@playwright/test';
import { currentTestEnv } from '../../promotions/index';
import type { EnvKey } from '../../promotions/types';
import { FIELD_APPEAR_TIMEOUT, annotateMissingField, fieldAppears, skipIfMissing } from './form-fields';
import { formatCpf, randomTestParticipant, randomValidCpf, type ParticipantData } from './participant-data';
import { devRecaptchaKeys, readPromotionCredentials } from './promotion-credentials';
import { runSharedValue } from './run-shared-value';
import { siteRoute } from './site-url';
import { API_TIMEOUT } from './test-constants';

export const BRAZILIAN_UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;

function cookieBannerButton(page: Page): Locator {
  return page.locator('#btn-cookies')
    .or(page.locator('[class*="cookie" i], [id*="cookie" i]').getByRole('button', { name: /prosseguir|aceitar/i }))
    .first();
}

export async function dismissCookieBanner(page: Page): Promise<void> {
  const cookieButton = cookieBannerButton(page);
  if (await cookieButton.count()) {
    await cookieButton.dispatchEvent('click').catch(() => {});
  }
}

/** O banner pode surgir depois do carregamento e cobrir botões; fecha antes de qualquer ação que ele bloquearia. */
export async function autoDismissCookieBanner(page: Page): Promise<void> {
  // dispatchEvent: clique por coordenada (force) pode cair num elemento sobreposto e não fechar o banner.
  await page.addLocatorHandler(cookieBannerButton(page), (button) => button.dispatchEvent('click'));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mesmo campo com id diferente entre projetos; a chave é o id usado nos specs. */
const FIELD_ID_ALIASES: Record<string, string[]> = {
  novidades: ['part_optin_noticias'],
};

/** Consentimentos obrigatórios que só alguns projetos têm: ausência não é anotada como campo faltando. */
const REQUIRED_CONSENT_IDS = ['optin_aviso_privacidade', 'optin_transferencia_dados', 'part_optin_lgpd'];

export function fieldSelector(id: string): string {
  return [id, ...(FIELD_ID_ALIASES[id] ?? [])].map((alias) => `#${alias}`).join(', ');
}

export function fieldError(page: Page, fieldId: string): Locator {
  return page.locator(`div:has(${fieldSelector(fieldId)}) > .error-form`);
}

export function messageModal(page: Page): Locator {
  return page.locator('#modalMsg');
}

/** Alguns fronts pedem "Confirme os dados informados" antes do POST; os outros mandam direto, às vezes já durante o clique. */
export async function submitConfirmingData(page: Page, button: Locator, submitPath: string, timeout = API_TIMEOUT): Promise<void> {
  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes(submitPath), { timeout }).then(() => false, () => false);
  await button.click();
  const confirm = page.getByRole('dialog').filter({ hasText: /confirme os dados/i }).getByRole('button', { name: /^confirmar$/i });
  const settled = confirm.or(messageModal(page)).or(page.locator('.error-form').filter({ hasText: /\S/ }));
  const shown = settled.filter({ visible: true }).first().waitFor({ state: 'visible', timeout }).then(() => confirm.isVisible(), () => false);
  if (await Promise.race([sent, shown])) await confirm.click();
}

const devRecaptchaActive = currentTestEnv() === 'dev' && !!process.env.PROMO && !!devRecaptchaKeys(process.env.PROMO);

/** Só no Dev com as chaves de teste do Google: o checkbox passa sem desafio e o backend valida o token. */
export async function checkRecaptcha(page: Page): Promise<void> {
  if (!devRecaptchaActive) return;
  const anchor = page.locator('iframe[title="reCAPTCHA"]').first().contentFrame().locator('#recaptcha-anchor');
  await anchor.click({ timeout: API_TIMEOUT });
  await expect(anchor, 'reCAPTCHA não marcou — confira se as chaves do Dev nos dados de acesso são as de teste do Google').toHaveAttribute('aria-checked', 'true');
}

export async function setCustomCheckbox(page: Page, id: string, checked: boolean): Promise<void> {
  const checkbox = page.locator(fieldSelector(id)).first();
  if ((await checkbox.isChecked()) !== checked) await checkbox.dispatchEvent('click');
  await expect(checkbox).toBeChecked({ checked });
}

export class LoginPage {
  readonly cpf: Locator;
  readonly cpfError: Locator;
  readonly submitButton: Locator;

  constructor(readonly page: Page, readonly siteUrl: string) {
    this.cpf = page.locator('#novo_cpf');
    this.cpfError = page.locator('#input-cpf-new-feedback');
    this.submitButton = page.locator('form:has(#novo_cpf) button[type="submit"]');
  }

  async open(): Promise<void> {
    const response = await this.page.goto(siteRoute(this.siteUrl, 'login'));
    expect(response?.status() ?? 200, '/login respondeu com erro').toBeLessThan(400);
    await expect(this.cpf, '/login não exibiu o campo de CPF').toBeVisible({ timeout: API_TIMEOUT });
    await expect(this.page, '/login redirecionou para outra rota').toHaveURL(/\/login\/?(?:[?#].*)?$/);
    await dismissCookieBanner(this.page);
  }

  async submitCpf(cpf: string): Promise<void> {
    if (cpf) await this.cpf.fill(cpf);
    await this.submitButton.click();
  }
}

export class RegistrationForm {
  readonly submitButton: Locator;

  constructor(readonly page: Page) {
    this.submitButton = page.getByRole('button', { name: /^enviar$/i });
  }

  static async open(page: Page, siteUrl: string, cpf: string = randomValidCpf()): Promise<RegistrationForm> {
    await page.addInitScript((value) => localStorage.setItem('cpf_cadastro', value), formatCpf(cpf));
    await page.goto(siteRoute(siteUrl, 'cadastro'));
    const form = new RegistrationForm(page);
    await form.submitButton.waitFor({ state: 'visible', timeout: API_TIMEOUT });
    await page.locator('form').filter({ has: form.submitButton }).locator('input').first().waitFor({ state: 'attached', timeout: API_TIMEOUT });
    form.openedAt = Date.now();
    await dismissCookieBanner(page);
    return form;
  }

  static async fillAndSubmit(page: Page, siteUrl: string, data: ParticipantData): Promise<RegistrationForm> {
    const form = await RegistrationForm.open(page, siteUrl, data.cpf);
    await form.fill(data);
    await form.submit();
    return form;
  }

  field(id: string): Locator {
    return this.page.locator(fieldSelector(id)).first();
  }

  /** Nome do campo nas mensagens do vee-validate (`data-vv-as`), que muda entre promoções. */
  async label(id: string, fallback: string): Promise<string> {
    return (await this.field(id).getAttribute('data-vv-as')) ?? fallback;
  }

  async requireEditable(id: string, label: string): Promise<void> {
    await this.requireField(id, label);
    test.skip(await this.field(id).isDisabled(), `campo "${label}" vem preenchido e bloqueado no formulário`);
  }

  /** Sem campo Sobrenome, o Nome recebe o nome completo: as duas formas são válidas, então a ausência não é anotada. */
  async hasFullNameField(): Promise<boolean> {
    return !(await this.appears('part_sobrenome'));
  }

  /** Busca de endereço pelo CEP só existe quando o formulário tem os campos de endereço. */
  async hasAddressLookup(): Promise<boolean> {
    return this.has('part_endereco', 'Endereço');
  }

  error(id: string): Locator {
    return fieldError(this.page, id);
  }

  private readonly presence = new Map<string, Promise<boolean>>();
  private openedAt = Date.now();

  /** Componentes lazy aparecem nos primeiros segundos do formulário; depois disso a checagem é imediata. */
  private appears(id: string): Promise<boolean> {
    const timeout = FIELD_APPEAR_TIMEOUT - (Date.now() - this.openedAt);
    if (!this.presence.has(id)) this.presence.set(id, fieldAppears(this.field(id), timeout));
    return this.presence.get(id)!;
  }

  async has(id: string, label: string): Promise<boolean> {
    if (await this.appears(id)) return true;
    annotateMissingField(label);
    return false;
  }

  async requireField(id: string, label: string): Promise<void> {
    skipIfMissing(await this.has(id, label), label);
  }

  /** Busca só pelo Tab: clicar em "Buscar" com o CEP focado dispara duas buscas (`change` + clique). */
  async searchCep(cep: string): Promise<void> {
    const lookup = this.page.waitForResponse((res) => /\/cep\b/.test(new URL(res.url()).pathname), { timeout: API_TIMEOUT }).catch(() => null);
    await this.field('part_cep').fill(cep);
    await this.field('part_cep').press('Tab');
    await lookup;
  }

  async submit(): Promise<void> {
    await submitConfirmingData(this.page, this.submitButton, '/api/register');
  }

  vueSelectSearch(id: string): Locator {
    return this.page.locator(`#${id} input.vs__search`);
  }

  vueSelectMenu(id: string): Locator {
    return this.page.locator(`#${id} .vs__dropdown-menu`);
  }

  vueSelectSelected(id: string): Locator {
    return this.page.locator(`#${id} .vs__selected`);
  }

  vueSelectOptions(id: string): Locator {
    return this.vueSelectMenu(id).locator('.vs__dropdown-option');
  }

  async openVueSelect(id: string, search?: string): Promise<void> {
    await this.vueSelectSearch(id).click();
    if (search !== undefined) await this.vueSelectSearch(id).fill(search);
    await this.vueSelectMenu(id).waitFor({ state: 'visible' });
  }

  async chooseVueSelectOption(id: string, text: string): Promise<void> {
    await this.openVueSelect(id, text);
    await this.vueSelectOptions(id).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`) }).first().click();
  }

  async chooseFirstVueSelectOption(id: string): Promise<void> {
    await this.openVueSelect(id);
    await this.page.keyboard.press('ArrowDown');
    await this.page.keyboard.press('Enter');
  }

  async fill(data: ParticipantData, { recaptcha = true } = {}): Promise<void> {
    const fullName = await this.hasFullNameField();
    const text: Array<[id: string, label: string, value: string]> = [
      ['part_nome', 'Nome', fullName ? `${data.nome} ${data.sobrenome}` : data.nome],
      ...(fullName ? [] : [['part_sobrenome', 'Sobrenome', data.sobrenome] as [string, string, string]]),
      ['part_data_nascimento', 'Data de nascimento', data.dataNascimento],
      ['part_telefone1', 'Celular', data.celular],
    ];
    for (const [id, label, value] of text) {
      if (await this.has(id, label) && await this.field(id).isEditable()) await this.field(id).fill(value);
    }
    if (await this.has('part_genero', 'Gênero')) await this.chooseFirstVueSelectOption('part_genero');

    const hasCep = await this.has('part_cep', 'CEP');
    const hasNumero = await this.has('part_numero', 'Número');
    if (hasCep && !(await this.hasAddressLookup())) {
      await this.field('part_cep').fill(data.cep);
    } else if (hasCep) {
      await this.searchCep(data.cep);
      await expect(this.field('part_endereco')).not.toHaveValue('', { timeout: API_TIMEOUT });
      // getCep() foca #part_numero 500ms após a resposta; sem esperar, o foco cai no meio do próximo fill.
      if (hasNumero) await expect(this.field('part_numero')).toBeFocused({ timeout: 2_000 }).catch(() => {});
    }
    if (hasNumero) await this.field('part_numero').fill(data.numero);

    const credentials: Array<[id: string, label: string, value: string]> = [
      ['email', 'E-mail', data.email],
      ['email_confirmation', 'Confirmar e-mail', data.email],
      ['password', 'Senha', data.senha],
      ['password_confirmation', 'Repetir senha', data.senha],
    ];
    for (const [id, label, value] of credentials) if (await this.has(id, label)) await this.field(id).fill(value);

    if (await this.has('part_optin_regulamento', 'Regulamento')) await setCustomCheckbox(this.page, 'part_optin_regulamento', true);
    for (const id of REQUIRED_CONSENT_IDS) if (await this.page.locator(fieldSelector(id)).count()) await setCustomCheckbox(this.page, id, true);
    if (data.optinWhats && await this.has('msg-whatsapp', 'Opt-in WhatsApp')) await setCustomCheckbox(this.page, 'msg-whatsapp', true);
    if (data.optinNoticias && await this.has('novidades', 'Opt-in novidades')) await setCustomCheckbox(this.page, 'novidades', true);
    if (await this.has('part_como_ficou_sabendo', 'Como ficou sabendo')) await this.chooseFirstVueSelectOption('part_como_ficou_sabendo');
    if (recaptcha) await checkRecaptcha(this.page);
  }
}

export async function disableFrontRecaptcha(page: Page): Promise<void> {
  if (devRecaptchaActive) return;
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      const meta = document.querySelector('meta[name="grcp"]');
      if (!meta) return;
      meta.setAttribute('content', '0');
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
}

export async function registerParticipant(page: Page, siteUrl: string, data: ParticipantData, { stayLoggedIn = false } = {}): Promise<void> {
  await RegistrationForm.fillAndSubmit(page, siteUrl, data);
  await expect(page, 'cadastro não chegou na tela de sucesso').toHaveURL(/cadastro-sucesso/, { timeout: API_TIMEOUT });
  if (!stayLoggedIn) await page.evaluate(() => localStorage.clear());
}

export async function registerFreshParticipant(page: Page, siteUrl: string, options: { stayLoggedIn?: boolean } = {}): Promise<ParticipantData> {
  await disableFrontRecaptcha(page);
  const device = test.info().project.name === 'mobile-chrome' ? 'Mob' : 'Desk';
  const participant = { ...randomTestParticipant(), sobrenome: `Teste Auto ${device}` };
  await registerParticipant(page, siteUrl, participant, options);
  return participant;
}

export function testParticipantCredentials(promotionId: string, testEnv: EnvKey): { cpf?: string; password?: string } {
  const { testParticipantCpf, testParticipantPassword } = readPromotionCredentials(promotionId)[testEnv] ?? {};
  return { cpf: testParticipantCpf, password: testParticipantPassword };
}

export async function loginParticipant(page: Page, siteUrl: string, cpf: string, password: string): Promise<void> {
  const login = new LoginPage(page, siteUrl);
  await login.open();
  await login.submitCpf(cpf);
  const passwordField = page.locator('#text-password');
  await expect(passwordField.or(page.getByRole('button', { name: /^enviar$/i })).first()).toBeVisible({ timeout: API_TIMEOUT });
  if (/\/cadastro$/.test(new URL(page.url()).pathname)) {
    throw new Error(`participante de teste (CPF ${cpf}) não existe neste ambiente — cadastre-o manualmente no site com o CPF e a senha dos dados de acesso`);
  }
  await passwordField.fill(password);
  await page.locator('form:has(#text-password) button[type="submit"]').click();
  await expect(page, 'login do participante de teste não completou — confira CPF/senha nos dados de acesso').not.toHaveURL(/\/login/, { timeout: API_TIMEOUT });
}

/** Fora do Dev o trace gravaria a senha e o token de sessão do participante de teste. */
export const SIGNED_IN_PARTICIPANT_TRACE = currentTestEnv() === 'dev' ? 'retain-on-failure' : 'off';

export async function signInParticipant(page: Page, siteUrl: string, promotionId: string, testEnv: EnvKey): Promise<void> {
  await page.goto(siteUrl);
  await page.evaluate(() => localStorage.removeItem('access_token'));

  let key = `fresh-participant-session|${siteUrl}|${test.info().project.name}`;
  let signIn = () => registerFreshParticipant(page, siteUrl, { stayLoggedIn: true }).then(() => {});
  if (testEnv === 'production') {
    const { cpf, password } = testParticipantCredentials(promotionId, testEnv);
    test.skip(!cpf || !password, 'informe CPF e senha do participante de teste nos dados de acesso deste ambiente');
    // Backend limita o login a 10/min por IP+CPF (429): loga uma vez por rodada.
    key = `participant-session|${siteUrl}|${cpf}`;
    signIn = () => loginParticipant(page, siteUrl, cpf!, password!);
  }

  let loggedInHere = false;
  const storage = await runSharedValue(key, async () => {
    await signIn();
    loggedInHere = true;
    return page.evaluate(() => ({ ...localStorage }));
  });
  if (loggedInHere) return;
  await page.evaluate((saved) => {
    for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
  }, storage);
}
