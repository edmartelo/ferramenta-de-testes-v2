import { test, type Locator, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { loginErrorMessage, submitEmailPasswordLogin, submitTotpCode } from '../../src/lib/admin-panel-flow';
import { PROMO_MONITOR_LOGIN_PATH, promoMonitorGuardOptions, installReadOnlyGuard } from '../../src/lib/read-only-guard';
import { RUN_MARKERS, emitMarker } from '../../src/lib/run-markers';
import { generateTotpCode } from '../../src/lib/totp';

type PromotionResult = {
  name: string;
  analyticsCount?: string;
  ok: boolean;
  failingLines: string[];
  registrationLines: { label: string; value: string }[];
  panelLinks: { label: string; url: string }[];
};

const MONITOR_URL = 'https://monitor.exemplo.com.br';

function emitProgress(label: string, current?: number, total?: number, promotion?: PromotionResult): void {
  emitMarker(RUN_MARKERS.recurrencesProgress, { label, current, total, promotion });
}

function failFriendly(message: string): never {
  emitMarker(RUN_MARKERS.recurrencesError, message);
  throw new Error(message);
}

function parseRegistrationLines(lines: string[]): { label: string; value: string }[] {
  return lines
    .filter((line) => /^último (cadastro|optin)/i.test(line))
    .map((line) => {
      const idx = line.indexOf(':');
      return { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
    });
}

// A contagem chega numa chamada separada, depois dos cards: sem a espera vem vazia.
async function waitForAnalyticsCounts(page: Page): Promise<void> {
  await page.locator('.analytics-count').first().waitFor({ timeout: 20_000 }).catch(() => undefined);
}

async function readAnalyticsCount(card: Locator): Promise<string | undefined> {
  const count = card.locator('.analytics-count').first();
  if (!(await count.count())) return undefined;
  const value = (await count.textContent())?.trim();
  return value || undefined;
}

// O botão "Painel" não é `<a href>`: abre via `window.open`, interceptado pra ler a URL sem abrir aba.
async function readPanelLinks(card: Locator): Promise<{ label: string; url: string }[]> {
  const links: { label: string; url: string }[] = [];
  const panelButton = card.getByRole('button', { name: /painel/i });
  if (await panelButton.count()) {
    await panelButton.click();
    const panelUrl = await card.page().evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls.pop());
    if (panelUrl) links.push({ label: 'Painel', url: panelUrl });
  }
  const siteUrl = await card.locator('a.link').first().getAttribute('href').catch(() => null);
  if (siteUrl) links.push({ label: 'Site', url: siteUrl });
  return links;
}

// Monitor de Promoções EM PRODUÇÃO. Trace gravaria senha e código 2FA.
test.use({ serviceWorkers: 'block', trace: 'off' });

test('escanear promoções ativas no painel de monitoramento', async ({ page, context }) => {
  test.skip(process.env.RECURRENCES_SCAN !== '1', 'só roda via botão "Recorrências"');
  test.setTimeout(5 * 60_000);

  const email = process.env.PROMO_MONITOR_EMAIL;
  const password = process.env.PROMO_MONITOR_PASSWORD;
  const totpCode = process.env.PROMO_MONITOR_TOTP_CODE;
  const totpSecret = process.env.PROMO_MONITOR_TOTP_SECRET;
  const outputPath = process.env.RECURRENCES_OUTPUT_PATH;
  const sessionPath = process.env.RECURRENCES_SESSION_PATH;
  if (!email || !password) throw new Error('PROMO_MONITOR_EMAIL/PROMO_MONITOR_PASSWORD não recebidos do test-runner (Monitor de Promoções não conectado em Configurações → Conectores).');
  if (!totpCode && !totpSecret) throw new Error('PROMO_MONITOR_TOTP_CODE (código digitado no modal) ou PROMO_MONITOR_TOTP_SECRET (chave do conector) não definido.');
  if (!outputPath || !sessionPath) throw new Error('RECURRENCES_OUTPUT_PATH/RECURRENCES_SESSION_PATH não definido.');

  const guard = await installReadOnlyGuard(context, MONITOR_URL, promoMonitorGuardOptions());

  emitProgress('Fazendo login no painel de monitoramento...');
  await page.goto(`${MONITOR_URL}/login`);
  const loginResponsePromise = page.waitForResponse(
    (r) => new URL(r.url()).pathname === PROMO_MONITOR_LOGIN_PATH && r.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await submitEmailPasswordLogin(page, email, password, 'Login');
  const loginResponse = await loginResponsePromise.catch(() =>
    failFriendly('Painel de monitoramento não respondeu ao login (tempo esgotado).'),
  );
  if (!loginResponse.ok()) {
    const body = await loginResponse.json().catch(() => null);
    failFriendly(`Login no Monitor de Promoções falhou: ${loginErrorMessage(loginResponse.status(), body)}`);
  }

  // "Insira o código..." é label, não placeholder: mira no único input visível.
  const totpInput = page.locator('input:visible').first();
  await totpInput.waitFor({ state: 'visible', timeout: 15_000 });
  await submitTotpCode(totpInput, () => totpCode ?? generateTotpCode(totpSecret!), 'Confirmar');

  // Código errado não sai de /login: abre um dialog "Código invalido." na mesma tela.
  const invalidCodeDialog = page.getByRole('dialog').filter({ hasText: /c[oó]digo inv[aá]lido/i });
  const loginOutcome = await Promise.race([
    page
      .waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 })
      .then(() => 'ok' as const)
      .catch(() => 'timeout' as const),
    invalidCodeDialog
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'invalid' as const)
      .catch(() => 'timeout' as const),
  ]);
  if (loginOutcome === 'invalid') failFriendly('O painel rejeitou seu código autenticador, Verifique.');
  if (loginOutcome === 'timeout') failFriendly('Painel de monitoramento não respondeu depois do login (tempo esgotado).');
  guard.endLoginPhase();
  guard.assertNoViolation();
  await context.storageState({ path: sessionPath });

  emitProgress('Abrindo painel de monitoramento...');
  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { __openedUrls: string[] }).__openedUrls = opened;
    window.open = (url?: string | URL) => {
      opened.push(String(url));
      return null;
    };
  });
  await page.goto(`${MONITOR_URL}/monitor`);
  const cards = page.locator('.monitorWrapper__card');
  await cards.first().waitFor({ timeout: 30_000 });
  await waitForAnalyticsCounts(page);
  guard.assertNoViolation();
  const cardCount = await cards.count();

  const promotions: PromotionResult[] = [];

  // Um modal por vez (o site só suporta um aberto). "sim" em qualquer linha = burlamento.
  for (let i = 0; i < cardCount; i++) {
    const card = cards.nth(i);
    const name = (await card.locator('.card__header h5').textContent())?.trim() ?? `Card ${i + 1}`;
    emitProgress(`Consultando ${name}...`, i, cardCount);

    const panelLinks = await readPanelLinks(card);
    const analyticsCount = await readAnalyticsCount(card);

    await card.getByRole('button', { name: /RECORR/i }).click();
    const dialogContent = page.locator('.dialogReccorenceWrapper__content');
    await dialogContent.waitFor({ state: 'visible', timeout: 15_000 });
    // Sem esperar o "Carregando..." a leitura vem `[]`; card sem dados abre vazio e conta como divergência.
    const items = page.locator('.dialogReccorenceWrapper__item');
    const hasItems = await items.first().waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);
    if (!hasItems && (await dialogContent.getByText(/carregando/i).count())) failFriendly(`Recorrências de ${name} não carregaram em 20 s.`);
    const lines = hasItems ? (await items.allTextContents()).map((line) => line.trim()) : [];

    const failingLines = hasItems
      ? lines.filter((line) => line.split(':').pop()?.trim().toLowerCase() === 'sim')
      : ['Card sem dados de recorrências'];

    const promotion = { name, analyticsCount, ok: failingLines.length === 0, failingLines, registrationLines: parseRegistrationLines(lines), panelLinks };
    promotions.push(promotion);
    emitProgress(`${name} analisada`, i + 1, cardCount, promotion);

    await page.locator('.dialogReccorenceWrapper__close-btn').click();
    await dialogContent.waitFor({ state: 'hidden', timeout: 15_000 });
    guard.assertNoViolation();
  }

  writeFileSync(outputPath, JSON.stringify({ promotions }), 'utf-8');
});

// Reusa a sessão salva pelo scan completo: sem login, nenhum POST passa pela trava.
test.describe('atualização da contagem de acessos', () => {
  test.skip(process.env.RECURRENCES_REFRESH !== '1', 'só roda via atualização automática de Recorrências');
  test.use({ storageState: process.env.RECURRENCES_SESSION_PATH });

  test('reler contagem de acessos no Monitor de Promoções', async ({ page, context }) => {
    const outputPath = process.env.RECURRENCES_OUTPUT_PATH;
    if (!outputPath) throw new Error('RECURRENCES_OUTPUT_PATH não definido.');

    const guard = await installReadOnlyGuard(context, MONITOR_URL, promoMonitorGuardOptions());
    guard.endLoginPhase();
    await page.goto(`${MONITOR_URL}/monitor`);
    const cards = page.locator('.monitorWrapper__card');
    const outcome = await Promise.race([
      cards.first().waitFor({ timeout: 30_000 }).then(() => 'ok' as const),
      page.waitForURL((url) => url.pathname.includes('/login'), { timeout: 30_000 }).then(() => 'expired' as const),
    ]).catch(() => 'timeout' as const);
    if (outcome === 'expired') failFriendly('A sessão do Monitor de Promoções expirou. Clique em "Consultar promoções" de novo.');
    if (outcome === 'timeout') failFriendly('Painel de monitoramento não respondeu (tempo esgotado).');
    await waitForAnalyticsCounts(page);
    guard.assertNoViolation();

    const counts: { name: string; analyticsCount?: string }[] = [];
    for (const card of await cards.all()) {
      const name = (await card.locator('.card__header h5').textContent())?.trim();
      if (name) counts.push({ name, analyticsCount: await readAnalyticsCount(card) });
    }
    guard.assertNoViolation();
    writeFileSync(outputPath, JSON.stringify({ counts }), 'utf-8');
  });
});
