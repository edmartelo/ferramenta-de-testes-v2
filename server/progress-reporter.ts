import type { FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { friendlyTestError } from '../src/lib/friendly-error.ts';
import { RUN_MARKERS, friendlyError } from '../src/lib/run-markers.ts';
import { CREATED_RECORD_ANNOTATION, MISSING_FIELD_ANNOTATION } from '../src/lib/test-constants.ts';

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${RUN_MARKERS.testProgress}${JSON.stringify(event)}\n`);
}

function describeTest(test: TestCase): { id: string; title: string } {
  const [, project, , ...titles] = test.titlePath();
  return { id: test.id, title: `${titles.join(' › ')} [${project}]` };
}

function firstLine(text: string | undefined): string | undefined {
  return text?.replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((line) => line.trim())?.trim();
}

function errorDetail(message: string | undefined): string | undefined {
  const line = firstLine(message);
  return line && friendlyError(line);
}

export default class ProgressReporter implements Reporter {
  onBegin(_config: unknown, suite: Suite): void {
    emit({ type: 'begin', total: suite.allTests().length });
  }

  onTestBegin(test: TestCase): void {
    emit({ type: 'test-begin', ...describeTest(test) });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const status = result.status === 'passed' ? 'ok' : result.status === 'skipped' ? 'not-applicable' : 'failed';
    const missing = result.annotations.filter((a) => a.type === MISSING_FIELD_ANNOTATION).map((a) => a.description);
    const created = result.annotations.filter((a) => a.type === CREATED_RECORD_ANNOTATION).map((a) => a.description);
    const okDetail = [
      ...created,
      ...(missing.length ? [`campos não encontrados no formulário: ${missing.join(', ')}`] : []),
    ].join(' — ');
    const detail = status === 'failed'
      ? friendlyTestError(result.errors.map((error) => error.message)) ?? errorDetail(result.error?.message)
      : status === 'not-applicable'
        ? test.annotations.find((a) => a.type === 'skip')?.description
        : okDetail || undefined;
    emit({ type: 'test-end', ...describeTest(test), status, detail });
  }

  onError(error: { message?: string }): void {
    emit({ type: 'error', message: errorDetail(error.message) });
  }

  onEnd(result: FullResult): void {
    emit({ type: 'end', status: result.status });
  }

  printsToStdio(): boolean {
    return true;
  }
}
