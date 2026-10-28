import { test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loginAdminPanel } from '../../src/lib/admin-panel-flow';
import { installReadOnlyGuard, resolvePanelUrl } from '../../src/lib/read-only-guard';
import { RUN_MARKERS, emitMarker } from '../../src/lib/run-markers';
import { siteRoute } from '../../src/lib/site-url';

type ReadOnlyGuard = Awaited<ReturnType<typeof installReadOnlyGuard>>;

type Atendimento = { id: string; participante: string; assunto: string; dataRecebimento: string; status: string; mensagem: string };

const ALL_STATUSES_VALUE = '0';
const DAYS_BACK = 1;
const MAX_PAGES = 200;
const ATENDIMENTOS_API_PATH = '/api/painel/atendimentos';

function emitProgress(label: string, collected: number, atendimento?: Atendimento): void {
  emitMarker(RUN_MARKERS.atendimentosProgress, { label, collected, atendimento });
}

function failFriendly(message: string): never {
  emitMarker(RUN_MARKERS.atendimentosError, message);
  throw new Error(message);
}

function listResponse(page: Page, timeout = 30_000) {
  return page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === ATENDIMENTOS_API_PATH, { timeout });
}

function isAttached(locator: Locator): Promise<boolean> {
  return locator.waitFor({ state: 'attached', timeout: 15_000 }).then(() => true, () => false);
}

// O componente de filtros é chunk sob demanda e pode chegar depois da listagem: espera, não `count()`.
async function openAtendimentosPage(page: Page, panelUrl: string): Promise<void> {
  const initialList = listResponse(page, 15_000).catch(() => null);
  const navigation = await page.goto(siteRoute(panelUrl, 'atendimentos')).catch(() => null);
  const list = await initialList;
  const routeProblems = [
    !navigation?.ok() && `página respondeu ${navigation?.status() ?? 'sem resposta'}`,
    !list?.ok() && `API de atendimentos ${list ? `respondeu ${list.status()}` : 'não foi chamada'}`,
    !/\/atendimentos\/?$/.test(new URL(page.url()).pathname) && `redirecionou para ${new URL(page.url()).pathname}`,
  ].filter(Boolean);
  // Sem a rota, esperar os filtros só gastaria 30 s.
  const missing = routeProblems.length > 0 ? routeProblems : [
    !(await isAttached(page.locator('select[name="statusAtendimento"]'))) && 'sem filtro de status',
    !(await isAttached(page.locator('input#envioDe'))) && 'sem filtro "Data Envio De"',
  ].filter(Boolean);
  if (missing.length > 0) failFriendly(`Rota de atendimento inexistente ou não localizada (${missing.join('; ')})`);
}

// A mensagem só existe no popover montado no hover; a linha tem outro botão "Responder" — só o `bi-eye`, nunca clique.
async function readMessageByHover(page: Page, row: Locator): Promise<string> {
  const eyeButton = row.locator('button:has(svg.bi-eye)').first();
  await eyeButton.hover();
  const popoverId = await eyeButton.getAttribute('aria-describedby');
  const body = popoverId ? page.locator(`#${popoverId} .popover-body`) : page.locator('.b-popover .popover-body').last();
  await body.waitFor({ state: 'visible', timeout: 5_000 });
  const text = (await body.innerText()).trim();
  await page.mouse.move(0, 0);
  await body.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
  return text;
}

function sortableDate(dataRecebimento: string): string {
  const [day = '', month = '', year = '', time = ''] = dataRecebimento.split(/[/\s]+/);
  return `${year}${month}${day}${time.replace(/:/g, '')}`;
}

function sinceDateLabel(): string {
  const since = new Date();
  since.setDate(since.getDate() - DAYS_BACK);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(since.getDate())}/${pad(since.getMonth() + 1)}/${since.getFullYear()}`;
}

async function collectRecent(page: Page, guard: ReadOnlyGuard, since: string): Promise<Atendimento[]> {
  await page.locator('select[name="statusAtendimento"]').selectOption(ALL_STATUSES_VALUE);
  await page.locator('input#envioDe').fill(since);
  const filteredList = listResponse(page);
  await page.getByRole('button', { name: /filtrar/i }).click();
  await filteredList;
  guard.assertNoViolation();

  const atendimentos: Atendimento[] = [];
  const seenIds = new Set<string>();

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    await page.locator('table tbody').waitFor({ state: 'attached', timeout: 15_000 });
    const rows = page.locator('table tbody tr');
    const rowCount = await rows.count();
    let newOnPage = 0;

    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const cells = (await row.locator('td').allInnerTexts()).map((cell) => cell.trim());
      if (cells.length < 6) continue;
      const [, id = '', participante = '', assunto = '', dataRecebimento = '', status = ''] = cells;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      newOnPage++;
      const atendimento = { id, participante, assunto, dataRecebimento, status, mensagem: await readMessageByHover(page, row) };
      guard.assertNoViolation();
      atendimentos.push(atendimento);
      emitProgress(`Página ${pageNumber}`, atendimentos.length, atendimento);
    }
    emitProgress(`Página ${pageNumber} lida`, atendimentos.length);

    const nextLink = page.locator('ul.pagination li:not(.disabled) a', { hasText: /next|»/i });
    if (newOnPage === 0 || (await nextLink.count()) === 0) break;
    const nextList = listResponse(page);
    await nextLink.first().click();
    await nextList;
    guard.assertNoViolation();
  }
  return atendimentos;
}

// Painel EM PRODUÇÃO. Trace e screenshot gravariam senha, código 2FA e dados de participantes.
test.use({ serviceWorkers: 'block', trace: 'off', screenshot: 'off' });

test('coletar atendimentos dos últimos dois dias', async ({ page, context, request }) => {
  test.skip(process.env.ATENDIMENTOS_SCAN !== '1', 'só roda via botão "Atendimentos" em Recorrências');
  test.setTimeout(30 * 60_000);

  const email = process.env.PROMO_MONITOR_EMAIL;
  const password = process.env.PROMO_MONITOR_PASSWORD;
  const totpCode = process.env.PROMO_MONITOR_TOTP_CODE;
  const totpSecret = process.env.PROMO_MONITOR_TOTP_SECRET;
  const linkedPanelUrl = process.env.ATENDIMENTOS_PANEL_URL;
  const promotionName = process.env.ATENDIMENTOS_PROMOTION_NAME;
  const outputPath = process.env.ATENDIMENTOS_OUTPUT_PATH;
  if (!email || !password) throw new Error('PROMO_MONITOR_EMAIL/PROMO_MONITOR_PASSWORD não recebidos do test-runner.');
  if (!totpCode && !totpSecret) throw new Error('PROMO_MONITOR_TOTP_CODE ou PROMO_MONITOR_TOTP_SECRET não definido.');
  if (!linkedPanelUrl || !promotionName || !outputPath) throw new Error('ATENDIMENTOS_PANEL_URL/ATENDIMENTOS_PROMOTION_NAME/ATENDIMENTOS_OUTPUT_PATH não definidos.');

  const panelUrl = await resolvePanelUrl(request, linkedPanelUrl);
  const guard = await installReadOnlyGuard(context, panelUrl, {
    apiReadPaths: [ATENDIMENTOS_API_PATH, '/api/painel/verifyDataEncerramentoHospedagem', '/api/promo-status'],
    documentPath: /\/atendimentos\/?$/,
    loginDocumentPath: /\/login\/?$/,
  });
  page.on('dialog', (dialog) => dialog.dismiss());

  emitProgress(`Fazendo login no painel de ${promotionName}...`, 0);
  await loginAdminPanel(page, panelUrl, email, password, { totpCode, totpSecret }).catch((error: Error) =>
    failFriendly(`Login no painel falhou: ${error.message.split('\n')[0]}`),
  );
  guard.endLoginPhase();
  guard.assertNoViolation();

  emitProgress('Abrindo Comunicações → Atendimentos...', 0);
  await openAtendimentosPage(page, panelUrl);
  guard.assertNoViolation();
  const since = sinceDateLabel();
  emitProgress(`Filtrando atendimentos desde ${since}...`, 0);
  const atendimentos = await collectRecent(page, guard, since);

  atendimentos.sort((a, b) => sortableDate(b.dataRecebimento).localeCompare(sortableDate(a.dataRecebimento)));
  guard.assertNoViolation();
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify({ promotionName, panelUrl, scannedAt: new Date().toISOString(), atendimentos }, null, 2), 'utf-8');
});
