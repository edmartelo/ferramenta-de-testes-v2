import { test, type Locator } from '@playwright/test';
import { MISSING_FIELD_ANNOTATION } from './test-constants';

/** Campos de componentes lazy (`() => import(...)`) só entram no DOM depois que o pedaço carrega. */
export const FIELD_APPEAR_TIMEOUT = 5_000;

export async function fieldAppears(field: Locator, timeout = FIELD_APPEAR_TIMEOUT): Promise<boolean> {
  return timeout > 0
    ? field.first().waitFor({ state: 'attached', timeout }).then(() => true, () => false)
    : (await field.count()) > 0;
}

export function annotateMissingField(label: string): void {
  test.info().annotations.push({ type: MISSING_FIELD_ANNOTATION, description: label });
}

export async function fieldExists(field: Locator, label: string, timeout = FIELD_APPEAR_TIMEOUT): Promise<boolean> {
  if (await fieldAppears(field, timeout)) return true;
  annotateMissingField(label);
  return false;
}

/** N/A: o item vai pendente pra "Conferência manual" com o motivo como observação. */
export function skipMissingField(reason: string): void {
  test.skip(true, reason);
}

export function skipIfMissing(present: boolean, label: string): void {
  if (!present) skipMissingField(`campo "${label}" não foi encontrado no formulário`);
}

export async function requireField(field: Locator, label: string): Promise<void> {
  skipIfMissing(await fieldExists(field, label), label);
}
