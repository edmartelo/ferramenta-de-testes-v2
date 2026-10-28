import { test } from '../../src/fixtures';
import { CREATED_RECORD_ANNOTATION, MASS_QUANTITY_ENV } from '../../src/lib/test-constants';

export function massQuantity(): number {
  return Number(process.env[MASS_QUANTITY_ENV]) || 0;
}

export function recordCreated(description: string): void {
  test.info().annotations.push({ type: CREATED_RECORD_ANNOTATION, description });
}
