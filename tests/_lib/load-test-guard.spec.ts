import { expect, test } from '@playwright/test';
import { assertConfirmed, LOAD_LIMITS, productionHosts, resolveLoadTarget, validateLoadSize } from '../../src/lib/load-test-guard';

const blocked = productionHosts([
  { environments: { site: { production: 'https://www.promocaoexemplo.com.br/' }, adminPanel: { production: 'https://painel.promocaoexemplo.com.br/' } } },
  { environments: { site: { staging: 'https://hmg.exemplo.com.br/x/' }, adminPanel: {}, api: { production: 'https://api.outrapromo.com.br/' } } },
]);

test.describe('teste de carga nunca roda em Produção', () => {
  for (const env of ['production', 'producao']) {
    test(`ambiente "${env}" é recusado`, () => {
      expect(() => resolveLoadTarget({ env, siteUrl: 'https://hmg.exemplo.com.br/x/', blockedHosts: blocked })).toThrow(/nunca roda em Produção/);
    });
  }

  test('ambiente desconhecido é recusado', () => {
    expect(() => resolveLoadTarget({ env: 'homolog', siteUrl: 'https://hmg.exemplo.com.br/x/', blockedHosts: blocked })).toThrow(/Dev ou Homolog/);
  });

  test('homolog apontando para host de Produção de qualquer promoção é recusado', () => {
    expect(() => resolveLoadTarget({ env: 'staging', siteUrl: 'https://www.promocaoexemplo.com.br/', blockedHosts: blocked })).toThrow(/Produção/);
    expect(() => resolveLoadTarget({ env: 'staging', siteUrl: 'https://PAINEL.promocaoexemplo.com.br/', blockedHosts: blocked })).toThrow(/Produção/);
  });

  test('homolog sem rótulo de ambiente de teste no host é recusado', () => {
    expect(() => resolveLoadTarget({ env: 'staging', siteUrl: 'https://www.outrapromo.com.br/', blockedHosts: blocked })).toThrow(/não tem cara de homolog/);
  });

  test('API de Produção é recusada mesmo com o site em homolog', () => {
    expect(() => resolveLoadTarget({ env: 'staging', siteUrl: 'https://hmg.exemplo.com.br/x/', apiUrl: 'https://www.promocaoexemplo.com.br/api', blockedHosts: blocked })).toThrow(/Produção/);
  });

  test('API cadastrada como de Produção é recusada', () => {
    expect(() => resolveLoadTarget({ env: 'staging', siteUrl: 'https://hmg.exemplo.com.br/x/', apiUrl: 'https://api.outrapromo.com.br/v1', blockedHosts: blocked })).toThrow(/Produção/);
  });

  test('API de homolog em outro host fica de fora em vez de receber carga', () => {
    const target = resolveLoadTarget({ env: 'staging', siteUrl: 'https://hmg.exemplo.com.br/x/', apiUrl: 'https://api-hmg.exemplo.com.br/x', blockedHosts: blocked });
    expect(target.apiUrl).toBeNull();
  });

  test('homolog no mesmo host do site é aceito', () => {
    const target = resolveLoadTarget({ env: 'staging', siteUrl: 'https://hmg.exemplo.com.br/x/', apiUrl: 'https://hmg.exemplo.com.br/x-api', blockedHosts: blocked });
    expect(target).toEqual({ env: 'staging', siteUrl: 'https://hmg.exemplo.com.br/x/', apiUrl: 'https://hmg.exemplo.com.br/x-api' });
  });

  test('Dev só aceita o servidor desta máquina', () => {
    expect(resolveLoadTarget({ env: 'dev', siteUrl: 'http://127.0.0.1:9000/', apiUrl: 'http://localhost:8000', blockedHosts: blocked }).apiUrl).toBe('http://localhost:8000/');
    expect(() => resolveLoadTarget({ env: 'dev', siteUrl: 'https://hmg.exemplo.com.br/x/', blockedHosts: blocked })).toThrow(/localhost/);
    expect(() => resolveLoadTarget({ env: 'dev', siteUrl: 'http://127.0.0.1:9000/', apiUrl: 'https://www.promocaoexemplo.com.br/api', blockedHosts: blocked })).toThrow(/Produção/);
  });

  test('URL sem http/https ou com usuário e senha é recusada', () => {
    expect(() => resolveLoadTarget({ env: 'staging', siteUrl: 'ftp://hmg.exemplo.com.br/', blockedHosts: blocked })).toThrow(/http ou https/);
    expect(() => resolveLoadTarget({ env: 'staging', siteUrl: 'https://a:b@hmg.exemplo.com.br/', blockedHosts: blocked })).toThrow(/usuário e senha/);
  });
});

test.describe('limites da carga', () => {
  test('acima do teto ou fora da duração é recusado', () => {
    expect(() => validateLoadSize(LOAD_LIMITS.maxUsers + 1, 60, true)).toThrow(/Usuários/);
    expect(() => validateLoadSize(0, 60, true)).toThrow(/Usuários/);
    expect(() => validateLoadSize(5, LOAD_LIMITS.maxDurationSec + 1, true)).toThrow(/Duração/);
    expect(() => validateLoadSize(5, LOAD_LIMITS.minDurationSec - 1, true)).toThrow(/Duração/);
  });

  test('mais que a rodada leve exige uma rodada leve sem erros antes', () => {
    expect(() => validateLoadSize(LOAD_LIMITS.smokeUsers + 1, 60, false)).toThrow(/rodada leve/);
    expect(validateLoadSize(LOAD_LIMITS.smokeUsers + 1, 60, true).users).toBe(LOAD_LIMITS.smokeUsers + 1);
    expect(validateLoadSize(LOAD_LIMITS.smokeUsers, 60, false).rampUpSec).toBe(5);
  });

  test('confirmação diferente do calculado é recusada', () => {
    const expected = { siteUrl: 'https://hmg.exemplo.com.br/x/', apiUrl: null, users: 5, durationSec: 60 };
    expect(() => assertConfirmed(expected, expected)).not.toThrow();
    expect(() => assertConfirmed({ ...expected, users: 50 }, expected)).toThrow(/confirmação/);
    expect(() => assertConfirmed({ ...expected, siteUrl: 'https://www.promocaoexemplo.com.br/' }, expected)).toThrow(/confirmação/);
    expect(() => assertConfirmed(undefined, expected)).toThrow(/confirmação/);
  });
});
