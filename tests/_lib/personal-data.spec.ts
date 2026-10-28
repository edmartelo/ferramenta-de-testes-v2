import { test, expect } from '@playwright/test';
import { maskPersonalData } from '../../server/personal-data';

test.describe('maskPersonalData', () => {
  test('tema repetido no grupo cita outro participante: some com os nomes de todos', () => {
    expect(maskPersonalData('Cadastro de cupom da maria souza', ['João Lima', 'Maria Souza'])).toBe('Cadastro de cupom da [NOME]');
  });

  test('primeiro nome sozinho também sai, sem cortar palavra maior nem conector', () => {
    expect(maskPersonalData('Maria e João das Neves; Mariana não', ['Maria das Dores', 'João Lima'])).toBe('[NOME] e [NOME] das Neves; Mariana não');
  });

  test('e-mail, telefone, CPF e código saem sem precisar de nome', () => {
    expect(maskPersonalData('Saldo errado, contato ana.paula@gmail.com ou (11) 98765-4321, CPF 123.456.789-09, cupom 1234567')).toBe(
      'Saldo errado, contato [EMAIL] ou [TELEFONE], CPF [CPF], cupom [CODIGO]',
    );
  });
});
