import { db } from '../src/lib/db.ts';
import { rootEnv } from '../src/lib/root-env.ts';

const KEEP_ALIVE_MS = 5 * 60_000;
// Em globalThis: o restart do Vite reimporta este módulo e o timer antigo continuaria rodando.
const keepAlive = globalThis as unknown as { __sharedDbKeepAlive?: ReturnType<typeof setInterval> };

/** O plano Free do Aiven desliga o banco por inatividade: uma escrita a cada 5 min enquanto algum `npm run dev` está aberto. */
export function startSharedDbKeepAlive(onError: (message: string) => void): void {
  clearInterval(keepAlive.__sharedDbKeepAlive);
  keepAlive.__sharedDbKeepAlive = setInterval(
    () =>
      void db()
        .then((pool) => pool.query("REPLACE INTO settings (name, value) VALUES ('keep_alive', ?)", [String(Date.now())]))
        .catch((error: Error) => onError(`Keep-alive do banco: ${error.message}`)),
    KEEP_ALIVE_MS,
  );
}

export interface SharedDbPower {
  running: boolean;
  error?: string;
}

/** Confere o serviço do banco no Aiven (o plano Free desliga por inatividade) e pede pra ligar quando está desligado. Sem `AIVEN_*` no `.env`, conta como ligado. */
export async function ensureSharedDbRunning(): Promise<SharedDbPower> {
  const token = rootEnv('AIVEN_API_TOKEN');
  const project = rootEnv('AIVEN_PROJECT');
  const service = rootEnv('AIVEN_SERVICE');
  if (!token || !project || !service) return { running: true };
  const url = `https://api.aiven.io/v1/project/${encodeURIComponent(project)}/service/${encodeURIComponent(service)}`;
  const headers = { Authorization: `aivenv1 ${token}`, 'Content-Type': 'application/json' };
  try {
    const current = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!current.ok) return { running: false, error: await aivenError(current) };
    const { service: info } = (await current.json()) as { service?: { state?: string } };
    if (info?.state === 'RUNNING') return { running: true };
    // REBUILDING/REBALANCING: já está subindo, só falta esperar.
    if (info?.state !== 'POWEROFF') return { running: false };
    const powerOn = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ powered: true }), signal: AbortSignal.timeout(30_000) });
    return powerOn.ok ? { running: false } : { running: false, error: await aivenError(powerOn) };
  } catch (error) {
    return { running: false, error: `Aiven: ${(error as Error).message}` };
  }
}

async function aivenError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
  return `Aiven respondeu ${response.status}${body?.message ? `: ${body.message}` : ''}`;
}
