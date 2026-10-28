/** Traduz o erro do Playwright de um teste que falhou numa frase para quem confere a rodada. */

const FIELD_NAMES: Record<string, string> = {
  part_cpf: 'CPF',
  novo_cpf: 'CPF',
  part_nome: 'Nome',
  part_sobrenome: 'Sobrenome',
  part_data_nascimento: 'Data de nascimento',
  part_genero: 'Gênero',
  part_telefone1: 'Celular',
  part_cep: 'CEP',
  part_estado: 'UF',
  part_cidade: 'Cidade',
  part_bairro: 'Bairro',
  part_endereco: 'Endereço',
  part_numero: 'Número',
  part_complemento: 'Complemento',
  email: 'E-mail',
  email_confirmation: 'Confirmar e-mail',
  password: 'Senha',
  password_confirmation: 'Repetir senha',
  'text-password': 'Senha',
  part_optin_regulamento: 'Regulamento',
  part_como_ficou_sabendo: 'Como ficou sabendo',
  novidades: 'Opt-in novidades',
  part_optin_noticias: 'Opt-in novidades',
  'msg-whatsapp': 'Opt-in WhatsApp',
  cupo_valor: 'Valor do cupom',
  fileInput: 'Imagem do cupom',
};

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function fieldName(id: string): string {
  return FIELD_NAMES[id] ?? id;
}

function describeLocator(locator: string | undefined): string {
  if (!locator) return 'o elemento esperado';
  const id = locator.match(/#([\w-]+)/)?.[1];
  if (locator.includes('.error-form') && id) return `a mensagem de erro do campo ${fieldName(id)}`;
  if (locator.includes('vs__') && id) return `a lista do campo ${fieldName(id)}`;
  if (id === 'modalMsg') return 'a janela de mensagem';
  if (id) return `o campo ${fieldName(id)}`;
  const button = locator.match(/getByRole\('button', \{ name: (?:\/\^?([^/$]+)\$?\/\w*|'([^']+)')/);
  if (button) return `o botão "${button[1] ?? button[2]}"`;
  if (/getByText\('([^']+)'/.test(locator)) return `o texto "${locator.match(/getByText\('([^']+)'/)![1]}"`;
  return 'o elemento esperado';
}

function readValue(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  const regex = value.match(/^\/(.*)\/\w*$/);
  if (regex) return regex[1]!.replace(/\\(.)/g, '$1').replace(/^\^|\$$/g, '');
  return value.replace(/^"(.*)"$/s, '$1');
}

function pagePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function field(lines: string[], ...labels: string[]): string | undefined {
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z ]+):\s?(.*)$/);
    if (match && labels.includes(match[1]!.trim())) return match[2];
  }
  return undefined;
}

function lastWaitedLocator(text: string): string | undefined {
  const waits = [...text.matchAll(/waiting for ((?:locator|getBy\w+)\(.*)$/gm)];
  return waits.at(-1)?.[1];
}

function describeExpectation(lines: string[], text: string): string | undefined {
  const matcher = text.match(/expect\((?:locator|page|received)\)\.(?:not\.)?(\w+)\(/)?.[1];
  if (!matcher) return undefined;
  const negated = /expect\(\w+\)\.not\./.test(text);
  const target = describeLocator(field(lines, 'Locator'));
  const expected = readValue(field(lines, 'Expected string', 'Expected substring', 'Expected pattern', 'Expected'));
  const received = readValue(field(lines, 'Received string', 'Received'));
  const notFound = text.includes('element(s) not found');

  switch (matcher) {
    case 'toHaveText':
    case 'toContainText':
      if (notFound) return `Não apareceu ${target} (esperado: "${expected}").`;
      if (!received) return `${capitalize(target)} apareceu vazia (esperado: "${expected}").`;
      return `${capitalize(target)} deveria ser "${expected}", mas apareceu "${received}".`;
    case 'toHaveURL':
      return `Esperado ir para a página "${expected}", mas ficou em "${pagePath(received)}".`;
    case 'toBeVisible':
      return negated ? `${capitalize(target)} continuou aparecendo na tela.` : `${capitalize(target)} não apareceu na tela.`;
    case 'toBeHidden':
      return `${capitalize(target)} continuou aparecendo na tela.`;
    case 'toHaveValue':
      if (negated) return `${capitalize(target)} ficou vazio.`;
      return `${capitalize(target)} ficou com "${received}" em vez de "${expected}".`;
    case 'toHaveCount':
      if (expected === '0') return `Apareceu ${target}, mas não devia.`;
      if (notFound || received === '0') return `Não apareceu ${target}.`;
      return `Quantidade diferente em ${target}: esperado ${expected}, encontrado ${received}.`;
    case 'toBeChecked':
      return `${capitalize(target)} não ficou marcado como esperado.`;
    case 'toBeFocused':
      return `${capitalize(target)} não recebeu o foco.`;
    case 'toHaveClass':
      return `${capitalize(target)} não foi aceito como válido.`;
    case 'toBe':
    case 'toEqual':
    case 'toBeLessThan':
      return `Resultado diferente do esperado: esperado ${expected || '—'}, obtido ${received || '—'}.`;
    default:
      return undefined;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `errors` é `result.errors` do Playwright: o primeiro costuma ser o timeout, o seguinte a ação que travou. */
export function friendlyTestError(errors: Array<string | undefined>): string | undefined {
  const messages = errors.filter((message): message is string => !!message).map(stripAnsi);
  if (!messages.length) return undefined;
  const all = messages.join('\n');

  if (all.includes('net::ERR_NAME_NOT_RESOLVED')) return 'Projeto ainda não publicado ou fora do ar.';
  if (/net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_TIMED_OUT|TIMED_OUT|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE)/.test(all)) {
    return 'O site não respondeu: está fora do ar ou sem conexão.';
  }

  const timeout = all.match(/Test timeout of (\d+)ms exceeded/);
  if (timeout) {
    const seconds = Math.round(Number(timeout[1]) / 1000);
    const blocked = /intercepts pointer events/.test(all) ? ' (outro elemento estava na frente, ex.: banner de cookies)' : '';
    const waited = lastWaitedLocator(all);
    if (waited) return `O teste passou do tempo limite (${seconds}s) esperando ${describeLocator(waited)}${blocked}.`;
    return `O teste passou do tempo limite (${seconds}s): a página ficou lenta ou travou.`;
  }

  const main = messages[0]!;
  const lines = main.split('\n');
  const firstLine = lines.find((line) => line.trim())?.trim() ?? '';
  const expectation = describeExpectation(lines, main);
  const custom = firstLine.match(/^Error: (.+)$/)?.[1];
  if (custom && !/^(expect|locator|page|apiRequest|browserContext|ENOENT|\w+\.\w+:)/.test(custom)) {
    const received = readValue(field(lines, 'Received string', 'Received'));
    if (/toHaveURL/.test(main) && received) return `${capitalize(custom)} (a página ficou em "${pagePath(received)}").`;
    return `${capitalize(custom)}.`;
  }
  if (expectation) return expectation;

  const timedOut = main.match(/Timeout (\d+)ms exceeded/);
  if (timedOut) {
    const seconds = Math.round(Number(timedOut[1]) / 1000);
    if (/waitForResponse/.test(main)) return `O servidor não respondeu em ${seconds}s.`;
    const waited = lastWaitedLocator(main);
    return `Tempo esgotado (${seconds}s) esperando ${describeLocator(waited)}.`;
  }
  if (/Target page, context or browser has been closed/.test(main)) return 'O navegador foi fechado antes do teste terminar.';

  return firstLine.replace(/^\w*Error: /, '');
}
