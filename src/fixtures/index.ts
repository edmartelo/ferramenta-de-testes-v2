import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import { test as base, expect } from '@playwright/test';
import { currentTestEnv, getActivePromotion, type EnvKey, type PromotionConfig } from '../../promotions';
import { LoginPage, RegistrationForm, autoDismissCookieBanner } from '../lib/registration-form';

export interface Fixtures {
  promotion: PromotionConfig;
  testEnv: EnvKey;
  siteUrl: string;
  loginPage: LoginPage;
  registrationForm: RegistrationForm;
}

type InitScript = Awaited<ReturnType<Page['addInitScript']>>;

let sharedContext: BrowserContext | undefined;
let sharedPage: Page | undefined;
const sharedPageInitScripts: InitScript[] = [];

async function allowStagingGate(context: BrowserContext, testEnv: EnvKey): Promise<void> {
  // Gate client-side (prompt() + localStorage "acesso_hmg"): sem a flag o app reabre o prompt em loop.
  if (testEnv === 'staging' || testEnv === 'dev') {
    await context.addInitScript(() => localStorage.setItem('acesso_hmg', '1'));
  }
}

async function newTestContext(browser: Browser, testEnv: EnvKey, options: BrowserContextOptions): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  await allowStagingGate(context, testEnv);
  return context;
}

function trackInitScripts(page: Page): void {
  const addInitScript = page.addInitScript.bind(page) as (...args: unknown[]) => Promise<InitScript>;
  page.addInitScript = (async (...args: unknown[]) => {
    const script = await addInitScript(...args);
    sharedPageInitScripts.push(script);
    return script;
  }) as Page['addInitScript'];
}

async function resetSharedPage(context: BrowserContext, page: Page): Promise<void> {
  await Promise.all(sharedPageInitScripts.splice(0).map((script) => script.dispose()));
  if (/^https?:/.test(page.url())) await page.evaluate(() => sessionStorage.clear()).catch(() => {});
  await page.goto('about:blank');
  await context.setStorageState({ cookies: [], origins: [] });
}

export const test = base.extend<Fixtures>({
  promotion: async ({}, use) => {
    await use(await getActivePromotion());
  },
  testEnv: async ({}, use) => {
    await use(currentTestEnv());
  },
  // Headless usa o context do Playwright, com todas as opções de `test.use`; headed reaproveita um por worker, só com o device do projeto.
  context: async ({ context, browser, testEnv, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch }, use, testInfo) => {
    if (testInfo.project.use.headless === false) {
      if (!sharedContext) sharedContext = await newTestContext(browser, testEnv, { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
      await use(sharedContext);
      return;
    }
    await allowStagingGate(context, testEnv);
    await use(context);
  },
  page: async ({ context }, use, testInfo) => {
    if (testInfo.project.use.headless === false) {
      if (!sharedPage || sharedPage.isClosed()) {
        sharedPage = await context.newPage();
        sharedPageInitScripts.length = 0;
        trackInitScripts(sharedPage);
        await autoDismissCookieBanner(sharedPage);
      } else {
        await resetSharedPage(context, sharedPage);
      }
      await use(sharedPage);
      return;
    }
    const page = await context.newPage();
    await autoDismissCookieBanner(page);
    await use(page);
    await page.close();
  },
  siteUrl: async ({ promotion, testEnv }, use) => {
    const url = promotion.environments.site[testEnv];
    test.skip(!url, `promoção sem URL de site para "${testEnv}"`);
    await use(url!.trim());
  },
  loginPage: async ({ page, siteUrl }, use) => {
    const loginPage = new LoginPage(page, siteUrl);
    await loginPage.open();
    await use(loginPage);
  },
  registrationForm: async ({ page, siteUrl }, use) => {
    await use(await RegistrationForm.open(page, siteUrl));
  },
});

export { expect };
