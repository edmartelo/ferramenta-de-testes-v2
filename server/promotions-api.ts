import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import type { Plugin } from 'vite';
import { AGENCIES, OTHER_AGENCY_ID, isAgencyId } from '../knowledge-base/agencies/index.ts';
import { MASS_REGISTRATION_GROUPS, MASS_REGISTRATION_LIMITS } from '../knowledge-base/test-groups.ts';
import { deletePromotion, listPromotions, promotionExists, readPromotion, writePromotion } from '../promotions/index.ts';
import { PROMOTION_STAGES, type EnvKey, type PromotionConfig, type PromotionStage } from '../promotions/types.ts';
import { testGroups, runAdminPanelLoginStreaming, runTestSuiteStreaming } from './test-runner.ts';

import { promotionDir } from '../src/lib/paths.ts';
import { MASS_QUANTITY_ENV } from '../src/lib/test-constants.ts';
import { existingAdminPanelSessionPath, readPromotionCredentials as readPanelCredentials, writePromotionCredentials as writePanelCredentials, type PromotionCredentials } from '../src/lib/promotion-credentials.ts';
import { getAuthenticatedRole, handleAuthRoute, handleUsersRoute, requireAuth } from './auth.ts';
import { db } from '../src/lib/db.ts';
import { handleConnectorsRoute, handleSlackOAuthCallback } from './connectors-api.ts';
import { handleDemoAccountsRoute } from './demo-accounts-api.ts';
import { startSharedDbKeepAlive } from './aiven-power.ts';
import { handleLearningRoute } from './learning-api.ts';
import { handleLogsRoute } from './logs.ts';
import { handleRecurrencesRoute } from './recurrences-api.ts';
import { startRecurrencesScheduler } from './recurrences-schedule.ts';
import { createTestRunRecorder, deleteTestRuns, isManualChecks, readLastTestRun, saveManualChecks } from './test-runs.ts';
import { BadRequestError, isCrossOriginWrite, readJsonBody, sendJson } from './http-utils.ts';

type UiEnv = 'dev' | 'homolog' | 'producao';

const ENV_TO_CONFIG_KEY = { dev: 'dev', homolog: 'staging', producao: 'production' } as const satisfies Record<UiEnv, EnvKey>;
const ENV_LABEL: Record<UiEnv, string> = { dev: 'Dev', homolog: 'Homolog', producao: 'Produção' };

function parseUiEnv(value: unknown): UiEnv | undefined {
  return value === 'dev' || value === 'homolog' || value === 'producao' ? value : undefined;
}

function slugify(text: string): string {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Pasta que sobrou (credenciais, sessão do painel) também ocupa o slug, senão a nova promoção herdaria esses arquivos. */
async function uniqueSlug(base: string): Promise<string> {
  const root = base || 'promocao';
  let slug = root;
  let n = 2;
  while (existsSync(promotionDir(slug)) || await promotionExists(slug)) {
    slug = `${root}-${n}`;
    n += 1;
  }
  return slug;
}

async function listPromotionSummaries(): Promise<(Pick<PromotionConfig, 'id' | 'name' | 'client' | 'agencyId'> & { stage: PromotionStage })[]> {
  return (await listPromotions()).map(({ id, name, client, agencyId, stage }) => ({ id, name, client, agencyId, stage: stage ?? 'testing' }));
}

/** Tester sabe que o campo está preenchido (a rodada precisa disso pra autenticar no painel) sem ver o valor. */
const HIDDEN_CREDENTIAL = '••••••••';

function hideCredentials(credentials: PromotionCredentials | undefined): PromotionCredentials {
  return Object.fromEntries(Object.entries(credentials ?? {}).map(([key, value]) => [key, value ? HIDDEN_CREDENTIAL : value]));
}

function applyEnvironmentFields(promotion: PromotionConfig, id: string, env: UiEnv, body: Record<string, unknown>, master: boolean): void {
  // Os links decidem onde as credenciais do Master são digitadas: Tester trocando o painel receberia senha e 2FA.
  if (!master) return;
  const configKey = ENV_TO_CONFIG_KEY[env];
  promotion.environments.site[configKey] = String(body.site ?? '').trim() || undefined;
  promotion.environments.adminPanel[configKey] = String(body.adminPanel ?? '').trim() || undefined;

  const normalize: Record<keyof PromotionCredentials, (value: string) => string> = {
    adminPanelUser: (value) => value.trim(),
    adminPanelPassword: (value) => value,
    adminPanelTotpSecret: (value) => value.replace(/\s/g, '').toUpperCase(),
    testParticipantCpf: (value) => value.replace(/\D/g, ''),
    testParticipantPassword: (value) => value,
    recaptchaSiteKey: (value) => value.trim(),
    recaptchaSecretKey: (value) => value.trim(),
  };
  const updates: PromotionCredentials = {};
  for (const [key, clean] of Object.entries(normalize) as Array<[keyof PromotionCredentials, (value: string) => string]>) {
    if (key in body) updates[key] = clean(String(body[key] ?? '')) || undefined;
  }
  if (Object.keys(updates).length) writePanelCredentials(id, configKey, updates);
}

function invalidLocalPath(value: string): boolean {
  return value !== '' && (!isAbsolute(value) || !existsSync(value) || !statSync(value).isDirectory());
}

interface PromotionRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  id: string;
  promotion: PromotionConfig;
  /** Tester roda testes e vê resultados; credenciais, pastas e exclusão são do Master. */
  master: boolean;
}

type PromotionRoute = (ctx: PromotionRouteContext) => unknown;

function putEnvironment(env: UiEnv): PromotionRoute {
  return async ({ req, res, id, promotion, master }) => {
    const body = await readJsonBody(req);
    if (env === 'dev' && master) {
      const paths = { backend: String(body.backend ?? '').trim(), frontend: String(body.frontend ?? '').trim() };
      if (invalidLocalPath(paths.backend) || invalidLocalPath(paths.frontend)) {
        return sendJson(res, 400, { error: 'Os caminhos do backend e do frontend precisam ser pastas existentes, com caminho absoluto.' });
      }
      promotion.paths = paths;
    }
    applyEnvironmentFields(promotion, id, env, body, master);
    await writePromotion(promotion);
    return sendJson(res, 200, promotion);
  };
}

function optionalNumber(value: unknown): number | undefined {
  const n = Number(value);
  return value !== '' && value != null && Number.isFinite(n) ? n : undefined;
}

const PROMOTION_ROUTES: Record<string, PromotionRoute> = {
  GET: ({ res, id, promotion, master }) => {
    const panelCreds = readPanelCredentials(id);
    const visible = master ? (credentials: PromotionCredentials | undefined) => credentials ?? {} : hideCredentials;
    return sendJson(res, 200, {
      ...promotion,
      credentialValues: {
        dev: visible(panelCreds.dev),
        staging: visible(panelCreds.staging),
        production: visible(panelCreds.production),
      },
      panelSessionSaved: {
        dev: Boolean(existingAdminPanelSessionPath(id, 'dev')),
        staging: Boolean(existingAdminPanelSessionPath(id, 'staging')),
        production: Boolean(existingAdminPanelSessionPath(id, 'production')),
      },
    });
  },

  DELETE: async ({ res, id, master }) => {
    if (!master) return sendJson(res, 403, { error: 'Só usuários Master excluem promoções.' });
    await deletePromotion(id);
    await deleteTestRuns(id);
    rmSync(promotionDir(id), { recursive: true, force: true });
    return sendJson(res, 200, { ok: true });
  },

  'PUT dev': putEnvironment('dev'),
  'PUT homolog': putEnvironment('homolog'),
  'PUT producao': putEnvironment('producao'),

  'PUT mechanics-rules': async ({ req, res, id, promotion }) => {
    const body = await readJsonBody(req);
    // As perguntas sim/não saíram do card; valores já salvos continuam valendo nos testes.
    const { allowMultipleCpf, allowMultipleEmail, allowMultiplePhone, participatingStoreCnpjs } = promotion.mechanicsRules ?? {};
    promotion.mechanicsRules = {
      allowMultipleCpf,
      allowMultipleEmail,
      allowMultiplePhone,
      participatingStoreCnpjs,
      minCouponValue: optionalNumber(body.minCouponValue),
      maxCouponsPerDay: optionalNumber(body.maxCouponsPerDay),
      maxCouponsTotal: optionalNumber(body.maxCouponsTotal),
      minProductsPerCoupon: optionalNumber(body.minProductsPerCoupon),
    };
    await writePromotion(promotion);
    return sendJson(res, 200, promotion);
  },

  'PUT stage': async ({ req, res, promotion }) => {
    const { stage } = await readJsonBody(req);
    if (!PROMOTION_STAGES.includes(stage as PromotionStage)) return sendJson(res, 400, { error: 'stage deve ser testing, live ou closed.' });
    promotion.stage = stage as PromotionStage;
    await writePromotion(promotion);
    return sendJson(res, 200, { stage });
  },

  'PUT manual-tests': async ({ req, res, id, promotion }) => {
    const body = await readJsonBody(req);
    const env = parseUiEnv(body.env);
    const configKey = env && env !== 'dev' ? ENV_TO_CONFIG_KEY[env] : undefined;
    if (!configKey || !Array.isArray(body.checked) || !body.checked.every((item: unknown) => typeof item === 'string')) {
      return sendJson(res, 400, { error: 'Informe o ambiente (homolog/producao) e a lista de itens marcados.' });
    }
    promotion.manualTestChecks = { ...promotion.manualTestChecks, [configKey]: body.checked };
    await writePromotion(promotion);
    return sendJson(res, 200, promotion);
  },

  'POST authenticate-panel': async ({ req, res, id, promotion }) => {
    const body = await readJsonBody(req);
    const env = parseUiEnv(body.env) ?? 'homolog';
    const configKey = ENV_TO_CONFIG_KEY[env];
    const creds = readPanelCredentials(id)[configKey];
    if (!creds?.adminPanelUser || !creds?.adminPanelPassword) {
      return sendJson(res, 400, { error: `Cadastre usuário e senha do painel de ${ENV_LABEL[env]} antes de autenticar.` });
    }
    if (!promotion.environments.adminPanel[configKey]) {
      return sendJson(res, 400, { error: 'Cadastre o link do painel antes de autenticar.' });
    }
    const totpCode = String(body.totpCode ?? '').trim();
    if (!totpCode && !creds.adminPanelTotpSecret) {
      return sendJson(res, 400, { error: 'Código do autenticador é obrigatório.' });
    }
    runAdminPanelLoginStreaming(
      {
        promotionId: id,
        envKey: configKey,
        email: creds.adminPanelUser,
        password: creds.adminPanelPassword,
        totpCode: totpCode || undefined,
        totpSecret: !totpCode ? creds.adminPanelTotpSecret : undefined,
      },
      res,
    );
  },

  'GET test-groups': ({ res }) => {
    const groups = testGroups().map(({ id, label, available, manualTests }) => ({ id, label, available, manualTests: manualTests ?? [] }));
    const massRegistration = {
      groups: MASS_REGISTRATION_GROUPS.map(({ id, label }) => ({ id, label })),
      limits: MASS_REGISTRATION_LIMITS,
    };
    return sendJson(res, 200, { groups, massRegistration });
  },

  'POST run-tests': async ({ req, res, id, promotion }) => {
    const body = await readJsonBody(req);
    const env = parseUiEnv(body.env) ?? 'homolog';
    const configKey = ENV_TO_CONFIG_KEY[env];
    if (!promotion.environments.site[configKey]) {
      return sendJson(res, 400, { error: 'Cadastre a URL do site desse ambiente antes de rodar os testes.' });
    }
    const onEvent = createTestRunRecorder(id, env, typeof body.group === 'string' && body.group ? body.group : 'all');
    const massGroup = MASS_REGISTRATION_GROUPS.find((group) => group.id === body.group);
    if (massGroup) {
      const limit = MASS_REGISTRATION_LIMITS[configKey];
      if (!limit) return sendJson(res, 400, { error: 'Cadastro em massa só roda em Dev e Homolog.' });
      const quantity = Number(body.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > limit) {
        return sendJson(res, 400, { error: `A quantidade precisa ser de 1 a ${limit} neste ambiente.` });
      }
      return runTestSuiteStreaming({
        promotionId: id,
        envKey: configKey,
        headed: body.headed === true,
        testDirectories: [massGroup.spec],
        extraArgs: ['--project=chromium'],
        extraEnv: { [MASS_QUANTITY_ENV]: String(quantity) },
        onEvent,
      }, res);
    }
    const available = testGroups().filter((group) => group.available);
    const requested = typeof body.group === 'string' && body.group ? body.group : undefined;
    const selected = requested ? available.filter((group) => group.id === requested) : available;
    if (!selected.length) {
      return sendJson(res, 400, { error: requested ? `Não há testes no grupo "${requested}".` : 'Ainda não há testes cadastrados.' });
    }
    runTestSuiteStreaming({ promotionId: id, envKey: configKey, headed: body.headed === true, testDirectories: selected.map((group) => group.directory), onEvent }, res);
  },

  'GET test-run': async ({ req, res, id }) => {
    const env = parseUiEnv(new URL(req.url ?? '', 'http://localhost').searchParams.get('env'));
    if (!env) return sendJson(res, 400, { error: 'Informe o ambiente (dev/homolog/producao).' });
    return sendJson(res, 200, await readLastTestRun(id, env));
  },

  'PUT test-run-checks': async ({ req, res, id }) => {
    const body = await readJsonBody(req);
    const env = parseUiEnv(body.env);
    const checks: unknown = body.checks;
    if (!env || !isManualChecks(checks)) {
      return sendJson(res, 400, { error: 'Informe o ambiente e o estado de cada item conferido.' });
    }
    if (!(await saveManualChecks(id, env, checks))) return sendJson(res, 404, { error: 'Nenhuma rodada salva nesse ambiente.' });
    return sendJson(res, 200, { ok: true });
  },
};

export function promotionsApiPlugin(): Plugin {
  return {
    name: 'promotions-api',
    configureServer(server) {
      db().catch((error: Error) => server.config.logger.error(`\n  ${error.message}\n`));
      startRecurrencesScheduler((message) => server.config.logger.error(`\n  ${message}\n`));
      startSharedDbKeepAlive((message) => server.config.logger.error(`\n  ${message}\n`));

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();

        try {
          const url = new URL(req.url, 'http://localhost');
          const parts = url.pathname.split('/').filter(Boolean);

          if (isCrossOriginWrite(req)) return sendJson(res, 403, { error: 'Origem não permitida.' });

          if (await handleAuthRoute(req, res, url.pathname)) return;
          if (await handleSlackOAuthCallback(req, res, url)) return;
          if (!(await requireAuth(req, res))) return;
          if (await handleUsersRoute(req, res, url.pathname)) return;
          if (await handleConnectorsRoute(req, res, url)) return;
          if (await handleRecurrencesRoute(req, res, url.pathname)) return;
          if (await handleLearningRoute(req, res, url.pathname)) return;
          if (await handleLogsRoute(req, res, url)) return;
          if (await handleDemoAccountsRoute(req, res, url)) return;

          if (req.method === 'GET' && parts.length === 2 && parts[1] === 'agencies') {
            return sendJson(res, 200, [
              ...Object.values(AGENCIES).map((a) => ({ id: a.id, name: a.name })),
              { id: OTHER_AGENCY_ID, name: 'Outro' },
            ]);
          }

          if (req.method === 'GET' && parts.length === 2 && parts[1] === 'promotions') {
            return sendJson(res, 200, await listPromotionSummaries());
          }

          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'promotions') {
            const body = await readJsonBody(req);
            const name = String(body.name ?? '').trim();
            const client = String(body.client ?? '').trim();
            const agencyId = String(body.agencyId ?? '').trim();
            if (!name || !client || !agencyId) {
              return sendJson(res, 400, { error: 'name, client e agencyId são obrigatórios.' });
            }
            const isOther = agencyId === OTHER_AGENCY_ID;
            if (!isOther && !isAgencyId(agencyId)) {
              return sendJson(res, 400, { error: `Agência desconhecida "${agencyId}".` });
            }
            const agencyName = isOther ? String(body.agencyName ?? '').trim() : '';
            const slug = await uniqueSlug(slugify(String(body.slug ?? name)));
            mkdirSync(promotionDir(slug), { recursive: true });
            const config: PromotionConfig = {
              id: slug,
              name,
              client,
              agencyId,
              ...(agencyName && { agencyName }),
              paths: { backend: '', frontend: '' },
              environments: { site: {}, adminPanel: {} },
              dates: { start: '', end: '' },
              mechanics: {
                hasCoupon: false,
                hasInstantPrizes: false,
                hasAccelerators: false,
                hasLuckyNumbers: false,
                hasWhatsAppBot: false,
                hasSuplente: false,
              },
            };
            await writePromotion(config);
            return sendJson(res, 201, config);
          }

          const routeKey = [req.method, ...parts.slice(3)].join(' ');
          const route = parts[1] === 'promotions' && (parts.length === 3 || parts.length === 4) && Object.hasOwn(PROMOTION_ROUTES, routeKey)
            ? PROMOTION_ROUTES[routeKey]
            : undefined;
          if (route) {
            const id = parts[2]!;
            const promotion = await readPromotion(id);
            if (!promotion) return sendJson(res, 404, { error: `Promoção "${id}" não encontrada.` });
            await route({ req, res, id, promotion, master: getAuthenticatedRole(req) === 'master' });
            return;
          }

          return sendJson(res, 404, { error: 'Rota de API desconhecida.' });
        } catch (error) {
          if (res.headersSent) return void res.end();
          return sendJson(res, error instanceof BadRequestError ? 400 : 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}
