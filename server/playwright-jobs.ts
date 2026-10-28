import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { constants } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { killLiveChildren, killProcessTree, trackChild } from '../src/lib/dev-bootstrap.ts';
import { PROJECT_ROOT } from '../src/lib/paths.ts';
import { sendJson } from './http-utils.ts';

/** `node <cli.js>` sem shell: no Windows o `cmd.exe` mata o processo (código 255) com `(`, `)`, `|` de um `--grep`. */
const PLAYWRIGHT_CLI = createRequire(import.meta.url).resolve('@playwright/test/cli');

const RESULTS_ROOT = join(PROJECT_ROOT, 'test-results');

export interface JobLock {
  key: string;
  busyMessage: string;
  /** Outros locks que também impedem este job de começar. */
  conflictsWith?: string[];
}

/** Testes, login no painel e Recorrências dividem porta, sessão e arquivo de saída: um de cada vez. */
export const EXCLUSIVE_LOCK: JobLock = {
  key: 'exclusive',
  busyMessage: 'Já existe uma execução em andamento (testes, login no painel ou Recorrências). Aguarde terminar ou cancele antes de iniciar outra.',
  conflictsWith: ['recurrences-refresh'],
};

/** Em globalThis: o restart do Vite reimporta o módulo enquanto o Playwright filho continua rodando. */
const activeJobs: Set<string> = ((globalThis as unknown as { __activePlaywrightJobs?: Set<string> }).__activePlaywrightJobs ??= new Set());

function isLockBusy(lock: JobLock): boolean {
  return activeJobs.has(lock.key) || (lock.conflictsWith ?? []).some((key) => activeJobs.has(key));
}
/** `--output` de jobs deste processo que já terminaram; em globalThis pra sobreviver ao restart do Vite. */
const finishedOutputDirs: Set<string> = ((globalThis as unknown as { __finishedOutputDirs?: Set<string> }).__finishedOutputDirs ??= new Set());

/** Só apaga saída de job deste processo que já terminou: `npm test` pela CLI e job rodando ficam intactos. */
function pruneFinishedResults(): void {
  for (const entry of finishedOutputDirs) {
    try {
      rmSync(join(RESULTS_ROOT, entry), { recursive: true, force: true });
      finishedOutputDirs.delete(entry);
    } catch {
      // arquivo preso por outro processo no Windows
    }
  }
}

// Só no servidor web e uma vez por processo: o restart do Vite reimporta este módulo.
const exitHooks = globalThis as unknown as { __killChildrenOnExit?: boolean };
if (!exitHooks.__killChildrenOnExit) {
  exitHooks.__killChildrenOnExit = true;
  process.once('exit', killLiveChildren);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      killLiveChildren();
      // Ouvir o sinal tira a saída padrão do Node; o SIGTERM do Vite já fecha o servidor e sai sozinho.
      if (process.listenerCount(signal) === 0) process.exit(128 + constants.signals[signal]);
    });
  }
}

export type EndFailure = { type: 'end'; success: false; error: string };

export interface PlaywrightNdjsonRun<E> {
  lock: JobLock;
  /** Um item por processo, em sequência: código 1 (teste falhou) segue, outro código não-zero encerra. */
  runs: string[][];
  env: NodeJS.ProcessEnv;
  /** A função devolvida roda no fim, ou quando a pessoa cancela. */
  prepare?: (write: (event: E) => void) => Promise<(() => Promise<void>) | undefined>;
  onLine?: (line: string, write: (event: E) => void) => void;
  /** `undefined` = falha genérica (ver `preferredError`). */
  onClose: (code: number | null) => E | undefined;
  preferredError?: () => string;
  /** Tudo que vai pra resposta, mais um `end` de cancelamento quando a pessoa aborta. */
  onEvent?: (event: E | EndFailure) => void;
}

interface JobOutput<E> {
  write(event: E | EndFailure): void;
  end(): void;
  onCancel(cancel: () => void): void;
}

const PLAYWRIGHT_ERROR_LINE = /^\s*(\w*Error: |Test timeout of )/;

export function spawnPlaywrightNdjson<E extends object>(res: ServerResponse, run: PlaywrightNdjsonRun<E>): void {
  if (isLockBusy(run.lock)) {
    sendJson(res, 409, { error: run.lock.busyMessage });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
  startPlaywrightJob(run, {
    write: (event) => res.write(JSON.stringify(event) + '\n'),
    end: () => res.end(),
    onCancel: (cancel) => res.on('close', cancel),
  });
}

/** Sem resposta HTTP, pro agendador e pelas rodadas pedidas pelo site. `undefined` = lock ocupado. */
export function runPlaywrightJob<E extends { type: string }>(run: PlaywrightNdjsonRun<E>, signal?: AbortSignal): Promise<Extract<E, { type: 'end' }> | EndFailure> | undefined {
  if (isLockBusy(run.lock)) return undefined;
  return new Promise((resolve) => {
    // O `end` do cancelamento só passa pelo `onEvent`, sem `output.end()`.
    const onEvent = (event: E | EndFailure) => {
      run.onEvent?.(event);
      if (event.type === 'end') resolve(event as Extract<E, { type: 'end' }> | EndFailure);
    };
    startPlaywrightJob({ ...run, onEvent }, {
      write: () => {},
      end: () => {},
      onCancel: (cancel) => signal?.addEventListener('abort', cancel, { once: true }),
    });
  });
}

export function isExclusiveJobRunning(): boolean {
  return activeJobs.has(EXCLUSIVE_LOCK.key);
}

/** O reporter `line` manda a falha pro stdout, então o erro de fallback é a primeira linha de erro dele. */
function startPlaywrightJob<E extends object>(run: PlaywrightNdjsonRun<E>, output: JobOutput<E>): void {
  activeJobs.add(run.lock.key);
  const outputName = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  pruneFinishedResults();
  function release(): void {
    activeJobs.delete(run.lock.key);
    finishedOutputDirs.add(outputName);
  }

  let ended = false;
  function write(event: E | EndFailure): void {
    if (ended) return;
    run.onEvent?.(event);
    output.write(event);
  }
  function finish(event: E | EndFailure): void {
    if (ended) return;
    write(event);
    ended = true;
    output.end();
  }

  let stdoutError = '';
  let stderrTail = '';
  let child: ChildProcess | undefined;
  let teardown: (() => Promise<void>) | undefined;
  let tornDown = false;
  let aborted = false;

  async function tearDownOnce(): Promise<void> {
    if (!teardown || tornDown) return;
    tornDown = true;
    await teardown();
  }

  function spawnOne(args: string[]): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const current = trackChild(spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', ...args, `--output=test-results/${outputName}`], { cwd: PROJECT_ROOT, env: run.env }));
      child = current;
      current.stdout.setEncoding('utf8');
      current.stderr.setEncoding('utf8');
      let stdoutBuffer = '';
      current.stdout.on('data', (text: string) => {
        stdoutBuffer += text;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!stdoutError && PLAYWRIGHT_ERROR_LINE.test(line)) stdoutError = line.trim();
          run.onLine?.(line, write);
        }
      });
      current.stderr.on('data', (text: string) => {
        stderrTail = (stderrTail + text).slice(-4000);
      });
      current.on('error', reject);
      current.on('close', resolve);
    });
  }

  async function runSequence(): Promise<number | null> {
    teardown = await run.prepare?.(write);
    let result: number | null = 0;
    try {
      for (const args of run.runs) {
        if (aborted) break;
        const code = await spawnOne(args);
        if (code === 1) result = 1;
        else if (code !== 0) return code;
      }
      return result;
    } finally {
      await tearDownOnce();
    }
  }

  output.onCancel(() => {
    if (ended) return;
    aborted = true;
    if (child) killProcessTree(child);
  });

  // Lock só sai depois do último processo e do teardown, mesmo se a pessoa cancelou.
  runSequence()
    .finally(release)
    .then(
      (code) => {
        if (aborted) return run.onEvent?.({ type: 'end', success: false, error: 'Execução cancelada.' });
        finish(
          run.onClose(code) ?? {
            type: 'end',
            success: false,
            error: run.preferredError?.() || stderrTail.trim() || stdoutError || `Processo encerrou com código ${code}.`,
          },
        );
      },
      (err: Error) => finish({ type: 'end', success: false, error: `Falha ao iniciar: ${err.message}` }),
    );
}

export function progressMarkerReader<E extends { type: string }>(progressMarker: string, errorMarker: string) {
  let friendlyError = '';
  return {
    onLine(line: string, write: (event: E) => void): void {
      if (line.startsWith(errorMarker)) {
        friendlyError = line.slice(errorMarker.length).trim();
        return;
      }
      if (!line.startsWith(progressMarker)) return;
      try {
        write({ type: 'progress', ...JSON.parse(line.slice(progressMarker.length)) } as E);
      } catch {
        // linha de progresso corrompida — ignora
      }
    },
    friendlyError: () => friendlyError,
  };
}
