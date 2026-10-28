import { existsSync, readdirSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { TEST_GROUPS, type TestGroup } from '../knowledge-base/test-groups.ts';
import { readPromotion } from '../promotions/index.ts';
import type { EnvKey } from '../promotions/types.ts';
import { DEV_PROJECT_MANAGED_ENV, startDevProject } from '../src/lib/dev-bootstrap.ts';
import { PROJECT_ROOT } from '../src/lib/paths.ts';
import { RUN_MARKERS } from '../src/lib/run-markers.ts';
import { EXCLUSIVE_LOCK, runPlaywrightJob, spawnPlaywrightNdjson, type PlaywrightNdjsonRun } from './playwright-jobs.ts';

interface AuthenticatePanelOptions {
  promotionId: string;
  envKey: EnvKey;
  email: string;
  password: string;
  /** Digitado no modal, nunca persistido. Ausente só quando há `totpSecret`. */
  totpCode?: string;
  totpSecret?: string;
}

export type AuthenticatePanelEvent = { type: 'end'; success: boolean; error?: string };

function adminPanelLoginRun(options: AuthenticatePanelOptions): PlaywrightNdjsonRun<AuthenticatePanelEvent> {
  let friendlyError = '';
  return {
    lock: EXCLUSIVE_LOCK,
    runs: [['tests/_setup/admin-panel-login.spec.ts', '--workers=1', '--project=chromium']],
    env: {
      ...process.env,
      PROMO: options.promotionId,
      TEST_ENV: options.envKey,
      ADMIN_PANEL_LOGIN_SETUP: '1',
      ADMIN_PANEL_LOGIN_EMAIL: options.email,
      ADMIN_PANEL_LOGIN_PASSWORD: options.password,
      ...(options.totpCode ? { ADMIN_PANEL_LOGIN_TOTP_CODE: options.totpCode } : {}),
      ...(options.totpSecret ? { ADMIN_PANEL_LOGIN_TOTP_SECRET: options.totpSecret } : {}),
    },
    onLine: (line) => {
      if (line.startsWith(RUN_MARKERS.adminPanelLoginError)) {
        friendlyError = line.slice(RUN_MARKERS.adminPanelLoginError.length).trim();
      }
    },
    onClose: (code) => (code === 0 ? { type: 'end', success: true } : undefined),
    preferredError: () => friendlyError,
  };
}

export function runAdminPanelLoginStreaming(options: AuthenticatePanelOptions, res: ServerResponse): void {
  spawnPlaywrightNdjson(res, adminPanelLoginRun(options));
}

export function runAdminPanelLoginJob(options: AuthenticatePanelOptions, signal?: AbortSignal) {
  return runPlaywrightJob(adminPanelLoginRun(options), signal);
}

export type TestRunEvent =
  | { type: 'begin'; total: number }
  | { type: 'test-begin'; id: string; title: string }
  | { type: 'test-end'; id: string; title: string; status: 'ok' | 'failed' | 'not-applicable'; detail?: string }
  | { type: 'error'; message?: string }
  | { type: 'status'; message: string }
  | { type: 'end'; success: boolean; error?: string };

export interface RunTestSuiteOptions {
  promotionId: string;
  envKey: EnvKey;
  headed: boolean;
  testDirectories: string[];
  extraArgs?: string[];
  extraEnv?: NodeJS.ProcessEnv;
  onEvent?: (event: TestRunEvent) => void;
}

interface AvailableTestGroup extends TestGroup {
  available: boolean;
  directory: string;
}

function withDirectory(group: TestGroup): AvailableTestGroup {
  const directory = `tests/${group.folder}`;
  const absolute = join(PROJECT_ROOT, directory);
  const available = existsSync(absolute) && readdirSync(absolute).some((file) => file.endsWith('.spec.ts'));
  return { ...group, available, directory };
}

export function testGroups(): AvailableTestGroup[] {
  return TEST_GROUPS.map(withDirectory);
}

/** Um `playwright test` por grupo, em sequência (`dependencies` pularia grupos após falha); o primeiro é `--list` pro total. */
function testSuiteRun(options: RunTestSuiteOptions): PlaywrightNdjsonRun<TestRunEvent> {
  const reporter = ['--reporter=./server/progress-reporter.ts', '--pass-with-no-tests'];
  const headed = options.headed ? ['--headed', '--workers=1'] : [];
  const extra = options.extraArgs ?? [];
  const runs = [
    [...options.testDirectories, '--list', ...reporter, ...extra],
    ...options.testDirectories.map((directory) => [directory, ...reporter, ...headed, ...extra]),
  ];

  const runErrors: string[] = [];
  let testsFinished = 0;
  let totalSent = false;
  return {
    lock: EXCLUSIVE_LOCK,
    runs,
    env: { ...process.env, ...options.extraEnv, PROMO: options.promotionId, TEST_ENV: options.envKey, [DEV_PROJECT_MANAGED_ENV]: '1' },
    prepare: async (write) => {
      const promotion = options.envKey === 'dev' ? await readPromotion(options.promotionId) : undefined;
      return promotion
        ? startDevProject(promotion, (message) => {
            console.log(`[dev-bootstrap] ${message}`);
            write({ type: 'status', message });
          })
        : undefined;
    },
    onLine: (line, write) => {
      if (!line.startsWith(RUN_MARKERS.testProgress)) return;
      try {
        const event = JSON.parse(line.slice(RUN_MARKERS.testProgress.length)) as TestRunEvent | { type: 'end'; status: string };
        if (event.type === 'end') return;
        if (event.type === 'begin') {
          if (totalSent) return;
          totalSent = true;
        }
        if (event.type === 'error' && event.message) runErrors.push(event.message);
        if (event.type === 'test-end') testsFinished += 1;
        write(event);
      } catch {
      }
    },
    onClose: (code) => (code === 0 || (code === 1 && testsFinished > 0 && !runErrors.length) ? { type: 'end', success: true } : undefined),
    preferredError: () => runErrors.join('\n'),
    onEvent: options.onEvent,
  };
}

export function runTestSuiteStreaming(options: RunTestSuiteOptions, res: ServerResponse): void {
  spawnPlaywrightNdjson(res, testSuiteRun(options));
}

export function runTestSuiteJob(options: RunTestSuiteOptions, signal?: AbortSignal) {
  return runPlaywrightJob(testSuiteRun(options), signal);
}
