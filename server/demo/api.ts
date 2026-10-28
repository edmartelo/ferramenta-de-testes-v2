import type { IncomingMessage, ServerResponse } from 'node:http';
import { BadRequestError, sendJson } from '../http-utils.ts';
import { handleDemoAuthRoute, isForeignWrite } from './accounts.ts';

const FULL_VERSION_ONLY = 'Disponível na versão completa da ferramenta.';

/** Hospedada como função, /api/* pode chegar com o caminho em `__path`. */
function apiPathname(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.searchParams.get('__path');
  return path === null ? url.pathname : `/api/${path}`;
}

/** Os conectores abrem /api/connectors/<nome>/authorize numa janela. */
function sendFullVersionPage(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><title>Modo demonstração</title><body style="font-family:sans-serif;padding:32px"><h1>Modo demonstração</h1><p>${FULL_VERSION_ONLY}</p></body>`);
}

/** Função pública da demo: só login/cadastro tocam o banco; o resto da tela é fictício e roda no navegador. */
export default async function handleDemoRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (isForeignWrite(req)) return void sendJson(res, 403, { error: 'Origem não permitida.' });
    const pathname = apiPathname(req);
    if (await handleDemoAuthRoute(req, res, pathname)) return;
    if (req.method === 'GET' && /^\/api\/connectors\/[a-z-]+\/authorize$/.test(pathname)) return sendFullVersionPage(res);
    sendJson(res, 404, { error: FULL_VERSION_ONLY });
  } catch (error) {
    if (res.headersSent) return void res.end();
    if (error instanceof BadRequestError) return void sendJson(res, 400, { error: error.message });
    // Sem `sql`, `sqlMessage` nem corpo: o log não leva e-mail, hash ou valores da consulta.
    const code = (error as { code?: unknown }).code;
    console.error(`${req.method} ${apiPathname(req)} falhou${typeof code === 'string' ? ` (${code})` : ''}`);
    sendJson(res, 500, { error: 'Erro interno. Tente de novo em instantes.' });
  }
}
