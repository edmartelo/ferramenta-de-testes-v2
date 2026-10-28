import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PromotionConfig } from '../../promotions/types.ts';
import { readJsonFile, writeJsonFile } from './json-file.ts';
import { promotionDir } from './paths.ts';

export type PromotionPaths = PromotionConfig['paths'];

/** Pastas do front/back mudam por máquina, então ficam fora do banco. */
function localPathsFile(id: string): string {
  return join(promotionDir(id), '.local-paths.json');
}

export function readPromotionPaths(id: string): PromotionPaths | undefined {
  return readJsonFile<PromotionPaths | undefined>(localPathsFile(id), undefined);
}

export function writePromotionPaths(id: string, paths: PromotionPaths): void {
  mkdirSync(promotionDir(id), { recursive: true });
  writeJsonFile(localPathsFile(id), paths);
}
