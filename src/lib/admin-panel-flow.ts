import { expect, type Locator, type Page } from '@playwright/test';
import type { EnvKey } from '../../promotions/types.ts';
import { adminPanelSessionPath } from './promotion-credentials.ts';
import { siteRoute } from './site-url.ts';
import { generateTotpCode } from './totp.ts';

const LOGIN_OUTCOME_TIMEOUT_MS = 30_000;
const LOGIN_STEP_PATH = /\/(login|check-code)(\/|$)/i;

export async function saveAdminPanelSession(page: Page, promotionId: string, envKey: EnvKey): Promise<void> {
  await page.context().storageState({ path: adminPanelSessionPath(promotionId, envKey) });
}

export async function submitEmailPasswordLogin(page: Page, email: string, password: string, loginButtonName: string | RegExp): Promise<void> {
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: loginButtonName }).click();
}

/** `.fill()` logo que o campo aparece some ou não dispara a validação: espera e digita tecla a tecla. */
export async function submitTotpCode(input: Locator, getCode: () => string, confirmButtonName: string | RegExp = /^confirmar$/i): Promise<void> {
  const page = input.page();
  await page.waitForTimeout(1000);
  await input.click();
  await input.pressSequentially(getCode(), { delay: 80 });
  await page.getByRole('button', { name: confirmButtonName }).click();
}

export function loginErrorMessage(status: number, body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  const text = typeof message === 'string' ? message : '';
  const blockedIp = text.match(/IP (\S+) NÃO AUTORIZADO/i)?.[1];
  if (blockedIp) return `IP ${blockedIp} não autorizado.`;
  return `Painel retornou erro ${status} no login${text ? `: ${text}` : '.'}`;
}

export interface AdminPanelLoginOptions {
  totpSecret?: string;
  totpCode?: string;
  /** Sem `totpSecret`/`totpCode`: espera uma pessoa digitar o código na janela (`--headed`). */
  manualCodeTimeoutMs?: number;
}

// Uns painéis têm rota `/check-code`, outros (BPremiado) trocam de passo dentro de `/login`.
async function waitForLoginOutcome(page: Page): Promise<'code' | 'logged' | 'timeout'> {
  const timeout = LOGIN_OUTCOME_TIMEOUT_MS;
  return Promise.race([
    page.locator('#code').waitFor({ state: 'visible', timeout }).then(() => 'code' as const, () => 'timeout' as const),
    page.waitForURL((url) => !LOGIN_STEP_PATH.test(url.pathname), { timeout }).then(() => 'logged' as const, () => 'timeout' as const),
  ]);
}

export async function loginAdminPanel(
  page: Page,
  adminPanelUrl: string,
  email: string,
  password: string,
  options: AdminPanelLoginOptions = {},
): Promise<void> {
  const loginUrl = siteRoute(adminPanelUrl, 'login');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="email"]').waitFor({ timeout: 15000 }).catch(() => {
    throw new Error(`Tela de login do painel não encontrada em ${loginUrl}. Confira a URL do painel.`);
  });

  const loginResponsePromise = page.waitForResponse(
    (r) => r.url().includes('/api/painel/login') && r.request().method() === 'POST',
    { timeout: 20000 },
  );

  await submitEmailPasswordLogin(page, email, password, /^login$/i);

  const loginResponse = await loginResponsePromise;
  const loginBody = await loginResponse.json().catch(() => ({}) as Record<string, unknown>);
  if (!loginResponse.ok()) throw new Error(loginErrorMessage(loginResponse.status(), loginBody));
  if (!loginBody?.user) {
    throw new Error('Credenciais inválidas. Verifique usuário e senha do painel.');
  }

  const outcome = await waitForLoginOutcome(page);
  if (outcome === 'timeout') throw new Error('Painel não abriu a tela do código nem entrou depois do login (tempo esgotado).');
  if (outcome === 'logged') return;

  const codeInput = page.locator('#code');

  // `user.gauth_token` só vem preenchido quando a conta ainda não tinha 2FA configurado.
  const secret: string | undefined = options.totpSecret ?? loginBody.user.gauth_token ?? undefined;
  if (options.totpCode || secret) {
    await submitTotpCode(codeInput, () => options.totpCode || generateTotpCode(secret!));
    const rejected = options.totpCode ? 'painel rejeitou o código do Authenticator' : 'código gerado não foi aceito';
    await expect(codeInput, rejected).toBeHidden({ timeout: 15000 });
    return;
  }
  await expect(codeInput, 'ninguém confirmou o código do Authenticator a tempo').toBeHidden({ timeout: options.manualCodeTimeoutMs ?? 300_000 });
}
