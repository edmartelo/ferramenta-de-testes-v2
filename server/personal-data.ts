// Ordem importa: link e e-mail antes dos números, CNPJ antes de CPF, telefone antes de código.
const PATTERNS: [RegExp, string][] = [
  [/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '[URL]'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[EMAIL]'],
  [/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[CNPJ]'],
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF]'],
  [/(?:\+?55\s?)?\(?\b\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g, '[TELEFONE]'],
  // Cupom, pedido, rastreio, chave de nota: 6+ caracteres com pelo menos um dígito, para não pegar palavra em caixa alta.
  [/\b(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{6,}\b/g, '[CODIGO]'],
];

const NAME_CONNECTORS = new Set(['das', 'dos', 'del', 'van', 'von']);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mascara dados do participante mantendo a frase natural; `names` vira [NOME], completo e cada parte com 3+ letras. */
export function maskPersonalData(text: string, names: string[] = []): string {
  let masked = PATTERNS.reduce((current, [pattern, token]) => current.replace(pattern, token), text);
  const parts = names
    .flatMap((name) => [name.trim(), ...name.trim().split(/\s+/)])
    .filter((part) => part.length >= 3 && !NAME_CONNECTORS.has(part.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  for (const part of new Set(parts)) {
    masked = masked.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(part)}(?![\\p{L}\\p{N}])`, 'giu'), '[NOME]');
  }
  return masked.replace(/\[NOME\](?:\s+\[NOME\])+/g, '[NOME]');
}
