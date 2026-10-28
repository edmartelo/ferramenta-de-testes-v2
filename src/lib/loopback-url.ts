const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Falha se a URL sair desta máquina: dado de participante só vai para serviço local. */
export function requireLoopbackUrl(value: string, name: string): string {
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    throw new Error(`${name} inválida: "${value}".`);
  }
  if (!LOOPBACK_HOSTS.has(hostname)) throw new Error(`${name} precisa apontar para esta máquina (127.0.0.1, localhost ou ::1), recebido "${hostname}".`);
  return value;
}
