import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024;

/** Corpo da requisição inválido — o middleware de `promotions-api.ts` responde 400 com a mensagem. */
export class BadRequestError extends Error {}

/** `SameSite=Lax` não separa portas: outra página em localhost mandaria o cookie num POST. */
export function isCrossOriginWrite(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return req.method !== 'GET' && req.method !== 'HEAD' && Boolean(origin) && origin !== `http://${req.headers.host}`;
}

export function sendJson(res: ServerResponse, status: number, data: unknown): true {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
  return true;
}

export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new BadRequestError('Corpo da requisição grande demais.');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestError('Corpo da requisição não é JSON válido.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError('Corpo da requisição precisa ser um objeto JSON.');
  }
  return parsed as Record<string, unknown>;
}
