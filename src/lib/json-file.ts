import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

/** No Windows o rename falha com EPERM/EBUSY enquanto outro processo lê o destino. */
export function writeFileAtomic(path: string, content: string): void {
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content, 'utf-8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmpPath, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        rmSync(tmpPath, { force: true });
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

export function writeJsonFile(path: string, data: unknown): void {
  writeFileAtomic(path, JSON.stringify(data, null, 2) + '\n');
}
