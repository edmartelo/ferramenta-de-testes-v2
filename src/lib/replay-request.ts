import type { Request } from '@playwright/test';

/** Cabeçalhos de uma requisição capturada, sem os que o Playwright recalcula ao reenviar. */
export async function replayHeaders(request: Request): Promise<Record<string, string>> {
  return Object.fromEntries(Object.entries(await request.allHeaders()).filter(([name]) => !/^(content-length|host|:)/i.test(name)));
}
