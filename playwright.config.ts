import { defineConfig, devices } from '@playwright/test';
import { currentTestEnv } from './promotions/index.ts';
import { MANUAL_IN_PRODUCTION } from './src/lib/test-constants.ts';

const testEnv = currentTestEnv();

export default defineConfig({
  globalSetup: './src/lib/dev-bootstrap.ts',
  testDir: './tests',
  // Pastas `_*` nunca rodam na suíte; caminho explícito (`npx playwright test tests/_lib/`, test-runner) continua valendo.
  ...(!process.argv.some((arg) => /(^|[\\/])tests[\\/]_/.test(arg)) && { testIgnore: /[\\/]tests[\\/]_[^\\/]+[\\/]/ }),
  fullyParallel: true,
  ...(testEnv === 'dev' && { workers: 3 }),
  // Em Produção desktop e mobile usam o mesmo participante de teste: um worker evita gravações simultâneas.
  ...(testEnv === 'production' && { workers: 1, grepInvert: new RegExp(MANUAL_IN_PRODUCTION) }),
  reporter: [['line']],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
  ],
});
