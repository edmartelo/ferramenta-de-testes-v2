import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const CERTS_TIMEOUT_MS = 5_000;
const DEFAULT_CERTS_TTL_MS = 60 * 60 * 1000;

export type GoogleJwk = JsonWebKey & { kid?: string };

export interface GoogleIdentity {
  email: string;
  name: string;
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf-8')) as Record<string, unknown>;
}

/** ID token do "Continuar com o Google": assinatura RS256 de uma chave do Google, emissor, público, validade e e-mail verificado. */
export function verifyGoogleIdToken(token: string, clientId: string, keys: GoogleJwk[], now = Date.now()): GoogleIdentity | undefined {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return undefined;
  try {
    const { alg, kid } = decodePart(header);
    const key = keys.find((candidate) => candidate.kid === kid);
    if (alg !== 'RS256' || !key) return undefined;
    const signed = verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(signature, 'base64url'));
    if (!signed) return undefined;
    const claims = decodePart(payload);
    if (!ISSUERS.includes(String(claims.iss)) || claims.aud !== clientId || Number(claims.exp) * 1000 <= now) return undefined;
    if (claims.email_verified !== true || typeof claims.email !== 'string') return undefined;
    const email = claims.email.toLowerCase();
    const name = typeof claims.name === 'string' && claims.name.trim().length >= 2 ? claims.name.trim().slice(0, 100) : email.split('@')[0]!.slice(0, 100);
    return { email, name };
  } catch {
    return undefined;
  }
}

let certs: { keys: GoogleJwk[]; expiresAt: number } | undefined;

/** Chaves públicas do Google em cache pelo `max-age` da resposta; `refresh` busca de novo quando chega um `kid` desconhecido. */
export async function googleKeys(refresh = false): Promise<GoogleJwk[]> {
  if (certs && !refresh && certs.expiresAt > Date.now()) return certs.keys;
  const response = await fetch(CERTS_URL, { signal: AbortSignal.timeout(CERTS_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Chaves do Google indisponíveis (${response.status}).`);
  const { keys } = (await response.json()) as { keys: GoogleJwk[] };
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1]);
  certs = { keys, expiresAt: Date.now() + (maxAge > 0 ? maxAge * 1000 : DEFAULT_CERTS_TTL_MS) };
  return keys;
}
