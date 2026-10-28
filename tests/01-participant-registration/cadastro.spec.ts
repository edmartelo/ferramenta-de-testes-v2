import { test, expect } from '../../src/fixtures';
import { skipMissingField } from '../../src/lib/form-fields';
import { randomTestParticipant } from '../../src/lib/participant-data';
import { BRAZILIAN_UFS, RegistrationForm, disableFrontRecaptcha, messageModal, setCustomCheckbox } from '../../src/lib/registration-form';
import { LANDLINE_CASES, MOBILE_CASES, PHONE_FIELD_ID, acceptsLandline, expectPhoneCase } from '../../src/lib/phone-field';
import { API_TIMEOUT, MANUAL_IN_PRODUCTION } from '../../src/lib/test-constants';

const UNKNOWN_CEP = '11111-111';

const REQUIRED_FIELDS: Array<[id: string, label: string]> = [
  ['part_cpf', 'CPF'],
  ['part_nome', 'Nome'],
  ['part_sobrenome', 'Sobrenome'],
  ['part_data_nascimento', 'Data de nascimento'],
  ['part_genero', 'Gênero'],
  ['part_telefone1', 'Celular'],
  ['part_cep', 'CEP'],
  ['part_estado', 'UF'],
  ['part_cidade', 'Cidade'],
  ['part_bairro', 'Bairro'],
  ['part_endereco', 'Endereço'],
  ['part_numero', 'Número'],
  ['email', 'E-mail'],
  ['email_confirmation', 'Confirmar e-mail'],
  ['password', 'Senha'],
  ['password_confirmation', 'Repetir senha'],
  ['part_optin_regulamento', 'Regulamento'],
  ['part_como_ficou_sabendo', 'Como ficou sabendo da promoção?'],
];

const FIELD_LABELS: Record<string, string> = {
  ...Object.fromEntries(REQUIRED_FIELDS),
  part_complemento: "Complemento",
};

function birthDateYearsAgo(years: number): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getFullYear()}`;
}

/** `editable: false` pra campo que só libera depois de outro (Cidade espera a UF). */
function describeField(id: string, label: string, body: () => void, { editable = true } = {}): void {
  test.describe(label, () => {
    test.beforeEach(async ({ registrationForm: form }) => (editable ? form.requireEditable(id, label) : form.requireField(id, label)));
    body();
  });
}

function labelOf(form: RegistrationForm, id: string): Promise<string> {
  return form.label(id, FIELD_LABELS[id] ?? id);
}

async function expectFieldError(form: RegistrationForm, id: string, fill: string, message: string | RegExp | ((label: string) => string)): Promise<void> {
  const expected = typeof message === "function" ? message(await labelOf(form, id)) : message;
  await form.field(id).fill(fill);
  await form.submit();
  await expect(form.error(id)).toContainText(expected);
}

test.describe('Cadastro de participante › /cadastro', () => {
  test('formulário em branco exibe erro de obrigatório em todo campo, exceto complemento e opt-ins opcionais', async ({ registrationForm: form }) => {
    const present: typeof REQUIRED_FIELDS = [];
    const fullName = await form.hasFullNameField();
    for (const [id, label] of REQUIRED_FIELDS) {
      if (id === 'part_sobrenome' && fullName) continue;
      if (await form.has(id, label) && !(await form.field(id).isDisabled())) present.push([id, await labelOf(form, id)]);
    }
    test.skip(!present.length, 'nenhum campo obrigatório editável conhecido existe no formulário');
    if (present.some(([id]) => id === 'part_cpf')) await form.field('part_cpf').fill('');
    await form.submit();

    for (const [id, label] of present) {
      await expect(form.error(id), id).toHaveText(`O campo ${label} é obrigatório`);
    }
    for (const optionalId of ['part_complemento', 'msg-whatsapp', 'novidades']) {
      await expect(form.error(optionalId), optionalId).toHaveCount(0);
    }
  });

  describeField('part_cpf', 'CPF', () => {
    test('vazio exibe erro de obrigatório', async ({ registrationForm: form }) => {
      await expectFieldError(form, 'part_cpf', '', (label) => `O campo ${label} é obrigatório`);
    });

    test('incompleto exibe erro de valor inválido', async ({ registrationForm: form }) => {
      await expectFieldError(form, 'part_cpf', '123456', (label) => `O valor do campo ${label} não é válido`);
    });
  });

  describeField('part_nome', 'Nome e sobrenome', () => {
    test('abaixo do mínimo de caracteres exibe erro', async ({ registrationForm: form }) => {
      if (await form.hasFullNameField()) {
        await expectFieldError(form, 'part_nome', 'Fulano', /nome completo/i);
        return;
      }
      await form.requireEditable('part_sobrenome', 'Sobrenome');
      await form.field('part_sobrenome').fill('Ma');
      await expectFieldError(form, 'part_nome', 'A', (label) => `O campo ${label} deve conter pelo menos 2 caracteres`);
      await expect(form.error('part_sobrenome')).toContainText(`O campo ${await labelOf(form, 'part_sobrenome')} deve conter pelo menos 3 caracteres`);
    });

    test('caracteres especiais exibem erro de alfabéticos', async ({ registrationForm: form }) => {
      const alphabeticError = (label: string) => `O campo ${label} só pode conter caracteres alfabéticos e espaços`;
      if (await form.hasFullNameField()) {
        await expectFieldError(form, 'part_nome', 'Fu@lan0# Silva', alphabeticError);
        return;
      }
      await form.requireEditable('part_sobrenome', 'Sobrenome');
      await form.field('part_sobrenome').fill('Mart&lo!');
      await expectFieldError(form, 'part_nome', 'Edu@rdo#', alphabeticError);
      await expect(form.error('part_sobrenome')).toContainText(alphabeticError(await labelOf(form, 'part_sobrenome')));
    });
  });

  describeField('part_data_nascimento', 'Data de nascimento', () => {
    test('aceita somente números', async ({ registrationForm: form }) => {
      await form.field('part_data_nascimento').fill('ab12cd34');
      await expect(form.field('part_data_nascimento')).toHaveValue('12/34');
    });

    test('mês 13 exibe erro de formato', async ({ registrationForm: form }) => {
      await expectFieldError(form, 'part_data_nascimento', '15/13/1990', 'O campo data de nascimento deve conter o formato DD/MM/AAAA');
    });

    test('menor de 18 anos exibe erro de idade mínima', { tag: MANUAL_IN_PRODUCTION }, async ({ page, siteUrl }) => {
      test.slow();
      await disableFrontRecaptcha(page);
      const form = await RegistrationForm.fillAndSubmit(page, siteUrl, { ...randomTestParticipant(), dataNascimento: birthDateYearsAgo(17) });
      await expect(form.error('part_data_nascimento')).toContainText('Idade mínima é de 18 anos', { timeout: API_TIMEOUT });
    });
  });

  describeField('part_genero', 'Gênero', () => {
    test('lista exatamente as opções obrigatórias', async ({ registrationForm: form }) => {
      await form.openVueSelect('part_genero');
      await expect(form.vueSelectOptions('part_genero')).toHaveText([
        'Masculino', 'Feminino', 'Não binário', 'Outro', 'Prefiro não informar',
      ]);
    });

    test('gênero fora da lista exibe "Gênero não encontrado."', async ({ registrationForm: form }) => {
      await form.openVueSelect('part_genero', 'xyzabc');
      await expect(form.vueSelectMenu('part_genero')).toHaveText('Gênero não encontrado.');
    });
  });

  describeField('part_telefone1', 'Telefone/Celular', () => {
    for (const phoneCase of MOBILE_CASES) {
      test(phoneCase.title, async ({ registrationForm: form }) => {
        await expectPhoneCase(form.field(PHONE_FIELD_ID), form.error(PHONE_FIELD_ID), phoneCase, () => form.submit());
      });
    }

    for (const phoneCase of LANDLINE_CASES) {
      test(phoneCase.title, async ({ registrationForm: form }) => {
        test.skip(!(await acceptsLandline(form.field(PHONE_FIELD_ID))), 'campo aceita só celular (máscara de 11 dígitos)');
        await expectPhoneCase(form.field(PHONE_FIELD_ID), form.error(PHONE_FIELD_ID), phoneCase, () => form.submit());
      });
    }
  });

  describeField('part_cep', 'CEP', () => {
    test('CEP não localizado exibe erro de preenchimento manual', async ({ registrationForm: form }) => {
      if (!(await form.hasAddressLookup())) skipMissingField('formulário sem campos de endereço: CEP não busca endereço');
      await form.searchCep(UNKNOWN_CEP);
      await expect(form.error('part_cep')).toContainText('CEP não localizado, preencher manualmente.', { timeout: API_TIMEOUT });
    });

    test('CEP válido preenche UF, cidade, bairro e endereço', async ({ registrationForm: form }) => {
      if (!(await form.hasAddressLookup())) skipMissingField('formulário sem campos de endereço: CEP não busca endereço');
      await form.searchCep(randomTestParticipant().cep);
      for (const [id, label] of <Array<[string, string]>>[['part_bairro', 'Bairro'], ['part_endereco', 'Endereço']]) {
        if (await form.has(id, label)) await expect(form.field(id), id).not.toHaveValue('', { timeout: API_TIMEOUT });
      }
      for (const [id, label] of <Array<[string, string]>>[['part_estado', 'UF'], ['part_cidade', 'Cidade']]) {
        if (await form.has(id, label)) await expect(form.vueSelectSelected(id), id).toHaveText(/\S/, { timeout: API_TIMEOUT });
      }
    });

    test('CEP com formato inválido exibe erro de formato', async ({ registrationForm: form }) => {
      await expectFieldError(form, 'part_cep', '0639', (label) => `O campo ${label} possui um formato inválido`);
    });
  });

  describeField('part_estado', 'UF', () => {
    test('lista todas as siglas dos estados brasileiros', async ({ registrationForm: form }) => {
      await form.openVueSelect('part_estado');
      const options = form.vueSelectOptions('part_estado');
      await expect(options).toHaveCount(BRAZILIAN_UFS.length);
      const listed = (await options.allInnerTexts()).map((text) => text.trim()).sort();
      expect(listed).toEqual([...BRAZILIAN_UFS].sort());
    });

    test('digitação aleatória exibe "Nenhum resultado encontrado!"', async ({ registrationForm: form }) => {
      await form.openVueSelect('part_estado', 'qwz');
      await expect(form.vueSelectMenu('part_estado')).toHaveText('Nenhum resultado encontrado!');
    });
  });

  describeField('part_cidade', 'Cidade', () => {
    test.beforeEach(async ({ registrationForm: form }) => form.requireField('part_estado', 'UF'));

    test('lista somente cidades da UF selecionada', async ({ registrationForm: form }) => {
      await form.chooseVueSelectOption('part_estado', 'AC');
      await form.openVueSelect('part_cidade');
      const cities = form.vueSelectOptions('part_cidade');
      await expect(cities.filter({ hasText: /^\s*Rio Branco\s*$/ })).toHaveCount(1);
      await expect(cities.filter({ hasText: /^\s*São Paulo\s*$/ })).toHaveCount(0);
    });

    test('digitação aleatória exibe "Nenhum resultado encontrado!"', async ({ registrationForm: form }) => {
      await form.chooseVueSelectOption('part_estado', 'SP');
      await form.openVueSelect('part_cidade', 'qwzxyk');
      await expect(form.vueSelectMenu('part_cidade')).toHaveText('Nenhum resultado encontrado!');
    });
  }, { editable: false });

  test('bairro, endereço e complemento aceitam digitação livre', async ({ registrationForm: form }) => {
    const candidates: Array<[id: string, label: string, value: string]> = [
      ['part_bairro', 'Bairro', 'Jardim Paulista'],
      ['part_endereco', 'Endereço', 'Rua das Flores 12'],
      ['part_complemento', 'Complemento', 'Apto 12, Bloco B'],
    ];
    const freeText: Record<string, string> = {};
    for (const [id, label, value] of candidates) if ((await form.has(id, label)) && !(await form.field(id).isDisabled())) freeText[id] = value;
    if (!Object.keys(freeText).length) skipMissingField('campos "Bairro", "Endereço" e "Complemento" não existem ou vêm bloqueados no formulário');
    for (const [id, value] of Object.entries(freeText)) await form.field(id).fill(value);
    await form.submit();
    await expect(form.page.locator('.error-form').filter({ hasText: /\S/ }).first(), 'validação do formulário em branco não rodou').toBeVisible();
    for (const [id, value] of Object.entries(freeText)) {
      await expect(form.field(id), id).toHaveValue(value);
      await expect(form.error(id), id).toHaveCount(0);
    }
  });

  test('número aceita no máximo 6 caracteres', async ({ registrationForm: form }) => {
    await form.requireEditable('part_numero', 'Número');
    await form.field('part_numero').fill('1234567');
    await expect(form.field('part_numero')).toHaveValue('123456');
  });

  test('e-mail inválido exibe erro de e-mail', async ({ registrationForm: form }) => {
    await form.requireField('email', 'E-mail');
    await expectFieldError(form, 'email', 'fulano.silva@', 'O campo e-mail deve ser um e-mail válido');
  });

  test('confirmar e-mail diferente exibe erro de igualdade', async ({ registrationForm: form }) => {
    await form.requireField('email', 'E-mail');
    await form.requireField('email_confirmation', 'Confirmar e-mail');
    await form.field('email').fill('qa.um@exemplo.com.br');
    const emailLabel = await labelOf(form, 'email');
    await expectFieldError(form, 'email_confirmation', 'qa.dois@exemplo.com.br', (label) => `Os campos ${label} e ${emailLabel} devem ser iguais`);
  });

  describeField('password', 'Senha', () => {
    for (const [pattern, password] of <Array<[string, string]>>[
      ['menos de 6 caracteres', 'Ab1'],
      ['sem número', 'Abcdefg'],
      ['sem letra maiúscula', 'abc1234'],
    ]) {
      test(`${pattern} exibe erro de formato`, async ({ registrationForm: form }) => {
        await expectFieldError(form, 'password', password, (label) => `O campo ${label} possui um formato inválido`);
      });
    }

    test('repetir senha diferente exibe erro de igualdade', async ({ registrationForm: form }) => {
      await form.requireField('password_confirmation', 'Repetir senha');
      await form.field('password').fill('Teste12345');
      const passwordLabel = await labelOf(form, 'password');
      await expectFieldError(form, 'password_confirmation', 'Teste54321', (label) => `Os campos ${label} e ${passwordLabel} devem ser iguais`);
    });
  });

  test('regulamento não aceito exibe erro de obrigatório', async ({ registrationForm: form }) => {
    await form.requireField('part_optin_regulamento', 'Regulamento');
    test.slow();
    await form.fill(randomTestParticipant());
    await setCustomCheckbox(form.page, 'part_optin_regulamento', false);
    await form.submit();
    await expect(form.error('part_optin_regulamento')).toHaveText(`O campo ${await labelOf(form, 'part_optin_regulamento')} é obrigatório`);
  });

  describeField('part_como_ficou_sabendo', 'Como ficou sabendo', () => {
    test('lista exatamente as opções previstas', async ({ registrationForm: form }) => {
      await form.openVueSelect('part_como_ficou_sabendo');
      await expect(form.vueSelectOptions('part_como_ficou_sabendo')).toHaveText([
        'TV', 'Amigos', 'Site de compras', 'Facebook', 'Instagram', 'Grupo de promoção',
        'Anúncio online', 'Comunicação em loja', 'Outros',
      ]);
    });

    test('digitação aleatória exibe "Nenhum resultado encontrado!"', async ({ registrationForm: form }) => {
      await form.openVueSelect('part_como_ficou_sabendo', 'qwzxyk');
      await expect(form.vueSelectMenu('part_como_ficou_sabendo')).toHaveText('Nenhum resultado encontrado!');
    });
  });

  test('envio sem reCAPTCHA abre modal pedindo confirmação do captcha', async ({ registrationForm: form }) => {
    test.slow();
    const captchaMeta = form.page.locator('meta[name="grcp"]');
    const captchaEnabled = (await captchaMeta.count()) ? await captchaMeta.first().getAttribute('content') : null;
    test.skip(captchaEnabled === '0', 'reCAPTCHA desligado no front (meta grcp=0)');
    await form.fill(randomTestParticipant(), { recaptcha: false });
    await form.submit();
    await expect(messageModal(form.page)).toContainText('Por favor, confirme o captcha.');
  });
});
