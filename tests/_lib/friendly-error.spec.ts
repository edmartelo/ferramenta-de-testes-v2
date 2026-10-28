import { test, expect } from '@playwright/test';
import { friendlyTestError } from '../../src/lib/friendly-error';

test.describe('friendlyTestError', () => {
  test('texto de erro diferente do esperado', () => {
    const message = [
      'Error: expect(locator).toContainText(expected) failed',
      '',
      "Locator: locator('div:has(#part_nome) > .error-form')",
      'Expected substring: "O campo Nome deve conter pelo menos 2 caracteres"',
      'Received string:    "Insira o seu nome completo."',
    ].join('\n');
    expect(friendlyTestError([message])).toBe('A mensagem de erro do campo Nome deveria ser "O campo Nome deve conter pelo menos 2 caracteres", mas apareceu "Insira o seu nome completo.".');
  });

  test('mensagem que não apareceu', () => {
    const message = [
      'Error: expect(locator).toContainText(expected) failed',
      '',
      "Locator: locator('div:has(#part_cep) > .error-form')",
      'Expected substring: "CEP não localizado, preencher manualmente."',
      'Error: element(s) not found',
    ].join('\n');
    expect(friendlyTestError([message])).toBe('Não apareceu a mensagem de erro do campo CEP (esperado: "CEP não localizado, preencher manualmente.").');
  });

  test('mensagem própria do teste com a página onde parou', () => {
    const message = [
      'Error: cadastro não chegou na tela de sucesso',
      '',
      'expect(page).toHaveURL(expected) failed',
      '',
      'Expected pattern: /cadastro-sucesso/',
      'Received string:  "https://hmg.exemplo.com.br/promo-exemplo-website/cadastro"',
    ].join('\n');
    expect(friendlyTestError([message])).toBe('Cadastro não chegou na tela de sucesso (a página ficou em "/promo-exemplo-website/cadastro").');
  });

  test('tempo limite com a ação que travou e o banner na frente', () => {
    const timeout = 'Test timeout of 30000ms exceeded.';
    const action = [
      'Error: locator.click: Target page, context or browser has been closed',
      'Call log:',
      "  - waiting for getByRole('button', { name: /^salvar$/i })",
      '      - <strong>Este website utiliza cookies</strong> from <div class="info-cookies">…</div> subtree intercepts pointer events',
    ].join('\n');
    expect(friendlyTestError([timeout, action])).toBe('O teste passou do tempo limite (30s) esperando o botão "salvar" (outro elemento estava na frente, ex.: banner de cookies).');
  });

  test('site fora do ar', () => {
    expect(friendlyTestError(['Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.test/'])).toBe('Projeto ainda não publicado ou fora do ar.');
  });
});
