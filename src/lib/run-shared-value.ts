import { test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './json-file.ts';

const WAIT_TIMEOUT_MS = 90_000;

/** Valor único por rodada entre workers, via arquivo no `outputDir` com lock `wx`. */
export async function runSharedValue<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const dir = join(test.info().project.outputDir, '.run-shared');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, createHash('sha1').update(key).digest('hex'));
  const valuePath = `${base}.json`;
  const lockPath = `${base}.lock`;

  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(valuePath)) return JSON.parse(readFileSync(valuePath, 'utf-8')) as T;
    let lock: number | undefined;
    try {
      lock = openSync(lockPath, 'wx');
    } catch {
      // Worker que estourou o timeout ou morreu não roda o `finally`: lock mais velho que a espera é abandonado.
      const lockAge = Date.now() - (statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (lockAge > WAIT_TIMEOUT_MS) rmSync(lockPath, { force: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    try {
      const value = await produce();
      writeFileAtomic(valuePath, JSON.stringify(value));
      return value;
    } finally {
      closeSync(lock);
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`outro worker não terminou de calcular "${key}" em ${WAIT_TIMEOUT_MS / 1000}s`);
}
