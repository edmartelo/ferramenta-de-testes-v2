import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { currentTestEnv, findActivePromotion } from '../../promotions/index.ts';
import type { PromotionConfig } from '../../promotions/types.ts';
import { devRecaptchaKeys } from './promotion-credentials.ts';

/** Setado pelo test-runner, que sobe o projeto uma vez pra todos os grupos. */
export const DEV_PROJECT_MANAGED_ENV = 'DEV_PROJECT_MANAGED';

const FRONTEND_START_TIMEOUT_MS = 120_000;

/** Cada etapa do bootstrap; o test-runner também repassa pra tela da rodada. */
export type DevLog = (message: string) => void;

const consoleLog: DevLog = (message) => console.log(`[dev-bootstrap] ${message}`);

/** Sem `taskkill /T` no Windows, `child.kill()` deixa o Vite (neto via `npm`/`cmd.exe`) órfão. */
export function killProcessTree(child: ChildProcess, { sync = false } = {}): void {
  if (child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const args = ['/pid', String(child.pid), '/T', '/F'];
    if (!sync) {
      spawn('taskkill', args);
      return;
    }
    // No `exit` do processo, um `taskkill` assíncrono morre junto com o pai (job do libuv) e deixa os netos.
    try {
      execFileSync('taskkill', args, { stdio: 'ignore' });
    } catch {
      // árvore já tinha encerrado
    }
  } else {
    child.kill();
  }
}

/** Em globalThis: o restart do Vite reimporta este módulo com filhos ainda rodando. */
const liveChildren: Set<ChildProcess> = ((globalThis as unknown as { __liveChildren?: Set<ChildProcess> }).__liveChildren ??= new Set());

/** Entra na lista que `killLiveChildren` derruba quando o servidor web sai. */
export function trackChild<T extends ChildProcess>(child: T): T {
  liveChildren.add(child);
  child.once('close', () => liveChildren.delete(child));
  return child;
}

export function killLiveChildren(): void {
  for (const child of liveChildren) {
    liveChildren.delete(child);
    killProcessTree(child, { sync: true });
  }
}

const GIT_TIMEOUT_MS = 2 * 60_000;
/** `up --wait` espera o healthcheck e, na primeira vez, baixa ou builda as imagens. */
const DOCKER_UP_TIMEOUT_MS = 10 * 60_000;
const DOCKER_STOP_TIMEOUT_MS = 2 * 60_000;

/** Estourou o prazo: mata a árvore e rejeita, senão um `git`/`docker` travado segura o lock exclusivo do test-runner. */
function runLogged(command: string, args: string[], cwd: string, log: DevLog, timeoutMs: number): Promise<number | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = trackChild(spawn(command, args, { cwd }));
    const timer = setTimeout(() => {
      killProcessTree(child);
      rejectPromise(new Error(`[dev-bootstrap] "${command} ${args.join(' ')}" em ${cwd} não terminou em ${timeoutMs / 60_000} min e foi encerrado.`));
    }, timeoutMs);
    const logLines = (chunk: Buffer) => chunk.toString().split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean).forEach(log);
    child.stdout.on('data', logLines);
    child.stderr.on('data', logLines);
    child.on('error', (err) => {
      clearTimeout(timer);
      log(`falha ao rodar "${command} ${args.join(' ')}": ${err.message}`);
      resolvePromise(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

const PULL_BRANCH = 'dev';

/** Nunca commit/push nesses projetos (CLAUDE.md): só descarta o local, puxa `dev` e reaplica o diff local (setup de teste). */
async function pullDevBranch(repo: string, label: string, log: DevLog): Promise<void> {
  if (!existsSync(join(repo, '.git'))) return;
  const git = (args: string[], input?: Buffer) => execFileSync('git', args, { cwd: repo, input, maxBuffer: 64 * 1024 * 1024 });
  const localFiles = git(['diff', '--name-only', 'HEAD']).toString().trim().split('\n').filter(Boolean);
  const localSetup = localFiles.length ? git(['diff', '--binary', 'HEAD']) : undefined;

  log(`${label}: descartando alterações locais e atualizando ${PULL_BRANCH} (git pull)...`);
  try {
    if ((await runLogged('git', ['checkout', '-f', PULL_BRANCH], repo, log, GIT_TIMEOUT_MS)) !== 0) {
      log(`${label}: não deu pra trocar pra ${PULL_BRANCH} — seguindo com o checkout atual.`);
    } else if ((await runLogged('git', ['pull', '--ff-only', 'origin', PULL_BRANCH], repo, log, GIT_TIMEOUT_MS)) !== 0) {
      log(`${label}: git pull falhou — seguindo com o checkout atual.`);
    }
  } finally {
    // Também no timeout do git: o setup local só existe neste diff em memória.
    if (localSetup) {
      try {
        git(['apply', '--whitespace=nowarn', '-'], localSetup);
        log(`${label}: setup local reaplicado (${localFiles.join(', ')}).`);
      } catch {
        const patch = join(tmpdir(), `${label}-setup-local-${Date.now()}.patch`);
        writeFileSync(patch, localSetup);
        log(`${label}: setup local conflita com o pull e não foi reaplicado (${localFiles.join(', ')}) — diff salvo em ${patch}.`);
      }
    }
  }
}

function setEnvVar(content: string, key: string, value: string): string {
  const line = `${key}="${value}"`;
  const existing = new RegExp(`^${key}=.*$`, 'm');
  return existing.test(content) ? content.replace(existing, () => line) : `${content.replace(/\s*$/, '\n')}${line}\n`;
}

function updateFile(path: string, update: (content: string) => string): boolean {
  const content = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const updated = update(content);
  if (updated !== content) writeFileSync(path, updated);
  return updated !== content;
}

/** Mode do `npm run dev` decide qual `.env.<mode>.local` o Vite lê por último. */
function viteDevMode(frontend: string): string {
  const script: string = JSON.parse(readFileSync(join(frontend, 'package.json'), 'utf-8')).scripts?.dev ?? '';
  return script.match(/--mode[= ](\S+)/)?.[1] ?? 'development';
}

/** Alteração local, nunca commitada: liga o reCAPTCHA com as chaves do Dev nos dados de acesso, ou desliga sem elas. */
function applyRecaptchaSetup(promotion: PromotionConfig, log: DevLog): void {
  const { backend, frontend } = promotion.paths;
  const keys = devRecaptchaKeys(promotion.id);

  const appConfig = backend && join(backend, 'config', 'app.php');
  if (appConfig && existsSync(appConfig)) {
    updateFile(appConfig, (content) => content.replace(/('RECAPTCHA_ENABLED'\s*=>\s*)(?:env\([^)]*\)|[^,\r\n]+)/, `$1${keys ? 'true' : 'false'}`));
    log(`back: reCAPTCHA ${keys ? 'ligado com as chaves do Dev' : 'desligado (sem chaves nos dados de acesso do Dev)'}.`);
  }
  if (!keys) return;

  const backendEnv = backend && join(backend, '.env');
  if (backendEnv && existsSync(backendEnv)) {
    updateFile(backendEnv, (content) => setEnvVar(setEnvVar(content, 'RECAPTCHA_SITE_KEY', keys.siteKey), 'RECAPTCHA_SECRET_KEY', keys.secretKey));
  } else if (backend) {
    log(`back: ${backendEnv} não existe — chave secreta do reCAPTCHA não aplicada.`);
  }
  if (frontend && existsSync(join(frontend, 'package.json'))) {
    updateFile(join(frontend, `.env.${viteDevMode(frontend)}.local`), (content) => setEnvVar(content, 'VITE_RECAPTCHA_SITE_KEY', keys.siteKey));
  }
}

function hasDockerBackend(backend: string | undefined): backend is string {
  return !!backend && existsSync(join(backend, 'docker-compose.yml'));
}

/** `stop`, não `down`: mantém containers e volume do banco. Timeout só vira log, pra não trocar o resultado da rodada. */
export async function stopDevBackend(backend: string | undefined, log: DevLog = consoleLog): Promise<void> {
  if (!hasDockerBackend(backend)) return;
  log(`parando backend Docker em ${backend} (docker compose stop)...`);
  await runLogged('docker', ['compose', 'stop'], backend, log, DOCKER_STOP_TIMEOUT_MS).catch(() =>
    log(`"docker compose stop" não terminou em ${DOCKER_STOP_TIMEOUT_MS / 60_000} min e foi encerrado — os containers podem ter ficado de pé.`),
  );
}

function listeningPids(port: string): string[] {
  try {
    if (process.platform === 'win32') {
      return [
        ...new Set(
          execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf-8' })
            .split('\n')
            .map((line) => line.trim().split(/\s+/))
            .filter((cols) => cols[3] === 'LISTENING' && cols[1]?.endsWith(`:${port}`))
            .map((cols) => cols[4])
            .filter((pid): pid is string => !!pid && pid !== '0'),
        ),
      ];
    }
    return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8' }).split('\n').map((pid) => pid.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function processName(pid: string): string {
  try {
    if (process.platform === 'win32') {
      const row = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf-8' }).trim();
      return row.startsWith('"') ? row.slice(1, row.indexOf('"', 1)) : '';
    }
    return execFileSync('ps', ['-p', pid, '-o', 'comm='], { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

/** Mata só processo Node na porta (front de outra promoção seria testado); outro dono da porta é erro. */
function freePort(port: string, log: DevLog): void {
  for (const pid of listeningPids(port)) {
    const name = processName(pid);
    if (!/^node(\.exe)?$/i.test(name)) {
      throw new Error(`[dev-bootstrap] porta ${port} ocupada por "${name || 'processo desconhecido'}" (PID ${pid}), que não é Node — libere a porta ou troque a URL do site Dev.`);
    }
    log(`porta ${port} ocupada por ${name} (PID ${pid}) — encerrando antes de subir o front.`);
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
    else process.kill(Number(pid), 'SIGKILL');
  }
}

async function waitForUrl(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + FRONTEND_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`[dev-bootstrap] "npm run dev" encerrou com código ${child.exitCode} antes de ${url} responder.`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  throw new Error(`[dev-bootstrap] ${url} não respondeu em ${FRONTEND_START_TIMEOUT_MS / 1000}s.`);
}

/** `--host 127.0.0.1`: Vite só escuta em `[::1]` por padrão (knowledge-base/local-testing-setup.md, seção 4); `--strictPort` falha em vez de trocar de porta calado. */
async function startDevFrontend(frontend: string, site: string, log: DevLog): Promise<ChildProcess> {
  const port = new URL(site).port;
  if (!port) throw new Error(`[dev-bootstrap] a URL do site Dev (${site}) precisa ter porta explícita, ex.: http://127.0.0.1:5173.`);
  freePort(port, log);
  const command = `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`;
  log(`subindo front em ${frontend} (${command})...`);
  const child = trackChild(spawn(command, { cwd: frontend, shell: true }));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[dev-bootstrap:front] ${chunk}`));
  child.stdout?.resume();
  try {
    await waitForUrl(site, child);
  } catch (err) {
    killProcessTree(child);
    throw err;
  }
  log(`front respondendo em ${site}.`);
  return child;
}

/** Migrate/passport continuam manuais (knowledge-base/local-testing-setup.md). */
export async function startDevProject(promotion: PromotionConfig, log: DevLog = consoleLog): Promise<(() => Promise<void>) | undefined> {
  const { backend, frontend } = promotion.paths;
  const site = promotion.environments.site.dev;

  if (backend && existsSync(backend)) await pullDevBranch(backend, 'back', log);
  if (frontend && existsSync(frontend)) await pullDevBranch(frontend, 'front', log);
  applyRecaptchaSetup(promotion, log);

  if (hasDockerBackend(backend)) {
    log(`subindo backend Docker em ${backend} (docker compose up -d --wait)...`);
    const code = await runLogged('docker', ['compose', 'up', '-d', '--wait'], backend, log, DOCKER_UP_TIMEOUT_MS);
    if (code !== 0) log(`"docker compose up -d --wait" saiu com código ${code} — siga com o backend manual.`);
  }

  let frontendProcess: ChildProcess | undefined;
  try {
    if (frontend && site && existsSync(frontend)) frontendProcess = await startDevFrontend(frontend, site, log);
  } catch (err) {
    await stopDevBackend(backend, log);
    throw err;
  }

  return async () => {
    if (frontendProcess) {
      log('encerrando front...');
      killProcessTree(frontendProcess, { sync: true });
    }
    await stopDevBackend(backend, log);
  };
}

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  if (currentTestEnv() !== 'dev' || process.env[DEV_PROJECT_MANAGED_ENV]) return undefined;
  const promotion = await findActivePromotion();
  return promotion ? startDevProject(promotion) : undefined;
}
