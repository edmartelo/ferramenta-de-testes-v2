import { test } from '../../src/fixtures';
import { loginAdminPanel, saveAdminPanelSession } from '../../src/lib/admin-panel-flow';
import { RUN_MARKERS, emitMarker, friendlyError } from '../../src/lib/run-markers';

// Trace e screenshot gravariam senha, código 2FA e cookies em disco.
test.use({ trace: 'off', screenshot: 'off' });

test('autenticar no painel e salvar sessão', async ({ page, promotion, testEnv }) => {
  test.skip(process.env.ADMIN_PANEL_LOGIN_SETUP !== '1', 'só roda quando falta sessão de painel ao clicar em "Rodar tudo" — nunca na suíte normal');
  test.setTimeout(60_000);

  const adminPanelUrl = promotion.environments.adminPanel[testEnv];
  if (!adminPanelUrl) throw new Error(`Sem URL de painel cadastrada pro ambiente "${testEnv}".`);

  const email = process.env.ADMIN_PANEL_LOGIN_EMAIL;
  const password = process.env.ADMIN_PANEL_LOGIN_PASSWORD;
  if (!email || !password) throw new Error('ADMIN_PANEL_LOGIN_EMAIL/PASSWORD não vieram do servidor (ver server/test-runner.ts).');
  const totpCode = process.env.ADMIN_PANEL_LOGIN_TOTP_CODE;
  const totpSecret = process.env.ADMIN_PANEL_LOGIN_TOTP_SECRET;

  try {
    await loginAdminPanel(page, adminPanelUrl, email, password, { totpCode, totpSecret });
    await saveAdminPanelSession(page, promotion.id, testEnv);
  } catch (e) {
    emitMarker(RUN_MARKERS.adminPanelLoginError, friendlyError(e instanceof Error ? e.message : String(e)));
    throw e;
  }
});
