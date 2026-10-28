import { test, expect } from '@playwright/test';
import { recurrencesMessage } from '../../src/lib/whatsapp';

test.describe('recurrencesMessage', () => {
  test('tudo ok vira uma linha só', () => {
    expect(recurrencesMessage([{ name: 'Promo A', failingLines: [] }])).toEqual(['Recorrências ok.']);
  });

  test('lista só as promoções com divergência e suas linhas', () => {
    const lines = recurrencesMessage([
      { name: 'Promo A', failingLines: [] },
      { name: 'Promo B', failingLines: ['Cupom repetido: sim', 'CPF repetido: sim'] },
    ]);
    expect(lines).toEqual(['Recorrências com divergência:', '', '*Promo B*', '- Cupom repetido: sim', '- CPF repetido: sim']);
  });
});
