import type { Severity } from '../api';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toggleInArray<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** `url` só se for http(s) — evita `javascript:`/`data:` vindo de dado externo num `:href`. */
export function safeHttpUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

export const SEVERITY_LABELS: Record<Severity, string> = {
  critica: 'Grave — falha de cadastro',
  alta: 'Alta',
  media: 'Média',
  baixa: 'Baixa',
  externo: 'Fora da alçada interna',
};
