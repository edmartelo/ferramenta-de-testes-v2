import { test, expect } from '../../src/fixtures';
import { randomValidCpf } from '../../src/lib/participant-data';
import { LoginPage, registerFreshParticipant, testParticipantCredentials } from '../../src/lib/registration-form';
import { API_TIMEOUT } from '../../src/lib/test-constants';

test.describe('Cadastro de participante › /login › CPF', () => {
  test('campo vazio exibe erro de obrigatório', async ({ loginPage }) => {
    await loginPage.submitCpf('');
    await expect(loginPage.cpfError).toHaveText('O campo CPF é obrigatório');
  });

  test('CPF incompleto exibe erro de valor inválido', async ({ loginPage }) => {
    await loginPage.submitCpf('123456');
    await expect(loginPage.cpfError).toHaveText('O valor do campo CPF não é válido');
  });

  test('CPF válido novo direciona para /cadastro', async ({ loginPage, page }) => {
    await loginPage.submitCpf(randomValidCpf());
    await expect(page).toHaveURL(/\/cadastro$/, { timeout: API_TIMEOUT });
  });

  test('CPF já cadastrado pede senha em vez de abrir o cadastro', async ({ page, siteUrl, testEnv, promotion }) => {
    test.skip(promotion.mechanicsRules?.allowMultipleCpf === true, 'mecânica permite múltiplos cadastros com o mesmo CPF');
    let cpf = testParticipantCredentials(promotion.id, testEnv).cpf;
    if (testEnv !== 'production') {
      test.slow();
      cpf = (await registerFreshParticipant(page, siteUrl)).cpf;
    }
    test.skip(!cpf, 'informe o "CPF de participante de teste já cadastrado" nos dados de acesso deste ambiente');

    const login = new LoginPage(page, siteUrl);
    await login.open();
    await login.submitCpf(cpf!);
    await expect(page.locator('#text-password')).toBeVisible({ timeout: API_TIMEOUT });
    await expect(page).toHaveURL(/\/login$/);
  });
});
