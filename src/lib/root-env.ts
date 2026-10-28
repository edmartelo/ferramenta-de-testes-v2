import { join } from 'node:path';
import dotenv from 'dotenv';
import { PROJECT_ROOT } from './paths.ts';

/** Objeto local, não `process.env`: senão senhas e chaves do `.env` vazariam pros filhos do Playwright. */
const ROOT_ENV: Record<string, string> = {};
dotenv.config({ path: join(PROJECT_ROOT, '.env'), processEnv: ROOT_ENV });

/** Variável do ambiente real ou, sem ela, do `.env` da raiz. */
export function rootEnv(key: string): string | undefined {
  return process.env[key] ?? ROOT_ENV[key];
}
