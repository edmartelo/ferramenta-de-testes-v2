/** Painéis sem tela de atendimentos (só têm e-mail marketing em Comunicações). Também importado pela tela. */
const HOSTS_WITHOUT_ATENDIMENTOS = new Set(['painel-sem-atendimentos.exemplo.com.br']);

export function hasAtendimentos(panelUrl: string): boolean {
  try {
    return !HOSTS_WITHOUT_ATENDIMENTOS.has(new URL(panelUrl).hostname);
  } catch {
    return false;
  }
}
