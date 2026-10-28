import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
export const PROMOTIONS_ROOT = join(PROJECT_ROOT, 'promotions');

export function promotionDir(id: string): string {
  return join(PROMOTIONS_ROOT, id);
}
