/** Prefixos de stdout lidos pelos jobs do servidor (test-runner, recurrences-scan, atendimentos-scan); ambos os lados importam daqui. */
export const RUN_MARKERS = {
  testProgress: '##TEST_PROGRESS##',
  adminPanelLoginError: '##ADMIN_PANEL_LOGIN_ERROR##',
  recurrencesProgress: '##RECURRENCES_PROGRESS##',
  recurrencesError: '##RECURRENCES_ERROR##',
  atendimentosProgress: '##ATENDIMENTOS_PROGRESS##',
  atendimentosError: '##ATENDIMENTOS_ERROR##',
} as const;

export function emitMarker(marker: string, payload: unknown): void {
  console.log(`${marker}${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
}

export function friendlyError(message: string): string {
  if (message.includes('net::ERR_NAME_NOT_RESOLVED')) return 'Projeto ainda não publicado ou Fora do ar';
  return message;
}
