import { reactive } from 'vue';
import {
  SONAR_ISSUE_TYPES,
  SONAR_SEVERITIES,
  type SonarDetails,
  type SonarIssueFilters,
  type SonarIssuePage,
  type SonarMeasures,
  type SonarProjectSummary,
  type SonarRating,
} from '../lib/sonar-types';

export const DEFAULT_PROXY_URL = 'http://127.0.0.1:9002';
const DEFAULT_SONAR_URL = 'http://127.0.0.1:9001';
const STORAGE_KEY = 'demo-sonar-connection';
const REQUEST_TIMEOUT_MS = 15_000;
// Os mesmos hosts que a CSP da demo libera em connect-src.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

export const sonarConnection = reactive({ proxyUrl: DEFAULT_PROXY_URL, token: '', sonarUrl: DEFAULT_SONAR_URL, connected: false });

export class SonarConnectionError extends Error {}

function readStored(): { proxyUrl: string; token: string } | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as { proxyUrl?: unknown; token?: unknown } | null;
    return parsed && typeof parsed.proxyUrl === 'string' && typeof parsed.token === 'string' ? { proxyUrl: parsed.proxyUrl, token: parsed.token } : null;
  } catch {
    return null;
  }
}

function writeStored(value: { proxyUrl: string; token: string } | null): void {
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Sem sessionStorage (modo privado restrito): a conexão vale só enquanto a página estiver aberta.
  }
}

const stored = readStored();
if (stored) Object.assign(sonarConnection, stored);


/** O token só pode ir para um proxy nesta máquina. */
function normalizeProxyUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SonarConnectionError('Endereço do proxy inválido. Use, por exemplo, http://127.0.0.1:9002.');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new SonarConnectionError('O proxy precisa rodar nesta máquina: use http://127.0.0.1:<porta> ou http://localhost:<porta>.');
  }
  return url.origin;
}

async function localNetworkDenied(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'local-network-access' as PermissionName });
    return status.state === 'denied';
  } catch {
    return false;
  }
}

async function proxyFetch(proxyUrl: string, token: string, path: string): Promise<Response> {
  try {
    return await fetch(`${proxyUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new SonarConnectionError(`O proxy em ${proxyUrl} não respondeu em ${REQUEST_TIMEOUT_MS / 1000} s.`);
    }
    if (await localNetworkDenied()) {
      throw new SonarConnectionError(
        'O Chrome bloqueou o acesso à rede local para este site. Clique no ícone ao lado do endereço, libere "Acesso à rede local" e tente de novo.',
      );
    }
    throw new SonarConnectionError(
      `Não foi possível falar com o proxy em ${proxyUrl}. Confira se o comando node sonar-cors-proxy.mjs está rodando nesta máquina; no Chrome, se aparecer o pedido de acesso à rede local, permita.`,
    );
  }
}

async function request<T>(proxyUrl: string, token: string, path: string): Promise<T | undefined> {
  const response = await proxyFetch(proxyUrl, token, path);
  if (response.status === 404) return undefined;
  if (response.status === 401) throw new SonarConnectionError('Token inválido ou expirado: gere um novo User Token no SonarQube (My Account → Security).');
  if (response.status === 403) throw new SonarConnectionError('O token não tem permissão para ler este projeto no SonarQube.');
  if (response.status === 502) throw new SonarConnectionError('O proxy está rodando, mas o SonarQube não respondeu. Confira se o container do SonarQube está no ar.');
  if (!response.ok) throw new SonarConnectionError(`O SonarQube respondeu HTTP ${response.status} em ${path.split('?')[0]}.`);
  try {
    return (await response.json()) as T;
  } catch {
    throw new SonarConnectionError(`O endereço ${proxyUrl} respondeu, mas não é o proxy do SonarQube. Confira a porta (o padrão do proxy é 9002).`);
  }
}

function sonarApi<T>(path: string): Promise<T | undefined> {
  return request<T>(sonarConnection.proxyUrl, sonarConnection.token, path);
}

let knownMetrics: Promise<Set<string>> | undefined;

function serverMetrics(): Promise<Set<string>> {
  knownMetrics ??= sonarApi<{ metrics: { key: string }[] }>('/api/metrics/search?ps=500')
    .then((result) => new Set((result?.metrics ?? []).map((metric) => metric.key)))
    .catch((error: unknown) => {
      knownMetrics = undefined;
      throw error;
    });
  return knownMetrics;
}

export async function connectSonar(proxyUrl: string, token: string): Promise<void> {
  const origin = normalizeProxyUrl(proxyUrl);
  const cleanToken = token.trim();
  if (!cleanToken) throw new SonarConnectionError('Cole o User Token do SonarQube.');
  const info = await request<{ target?: string }>(origin, '', '/proxy-info');
  const user = await request<{ isLoggedIn?: boolean }>(origin, cleanToken, '/api/users/current');
  if (!user?.isLoggedIn) throw new SonarConnectionError('Token inválido ou expirado: gere um novo User Token no SonarQube (My Account → Security).');
  knownMetrics = undefined;
  Object.assign(sonarConnection, { proxyUrl: origin, token: cleanToken, sonarUrl: info?.target ?? DEFAULT_SONAR_URL, connected: true });
  writeStored({ proxyUrl: origin, token: cleanToken });
}

/** Depois de recarregar a página: reconecta com o que ficou na sessão, sem pedir o token de novo. */
export async function restoreSonarConnection(): Promise<boolean> {
  if (sonarConnection.connected) return true;
  if (!sonarConnection.token) return false;
  await connectSonar(sonarConnection.proxyUrl, sonarConnection.token);
  return true;
}

export function disconnectSonar(): void {
  knownMetrics = undefined;
  Object.assign(sonarConnection, { token: '', connected: false });
  writeStored(null);
}

type MeasureKey = keyof SonarMeasures;
type MetricCandidates = { overall: string[]; newCode: string[] };

/** Vale a primeira chave que o servidor devolve: `software_quality_*` é do modo MQR, as outras do modo padrão. */
const DETAIL_METRICS: Record<MeasureKey, MetricCandidates> = {
  security: { overall: ['software_quality_security_issues', 'vulnerabilities'], newCode: ['new_software_quality_security_issues', 'new_vulnerabilities'] },
  securityRating: { overall: ['software_quality_security_rating', 'security_rating'], newCode: ['new_software_quality_security_rating', 'new_security_rating'] },
  reliability: { overall: ['software_quality_reliability_issues', 'bugs'], newCode: ['new_software_quality_reliability_issues', 'new_bugs'] },
  reliabilityRating: { overall: ['software_quality_reliability_rating', 'reliability_rating'], newCode: ['new_software_quality_reliability_rating', 'new_reliability_rating'] },
  maintainability: { overall: ['software_quality_maintainability_issues', 'code_smells'], newCode: ['new_software_quality_maintainability_issues', 'new_code_smells'] },
  maintainabilityRating: { overall: ['software_quality_maintainability_rating', 'sqale_rating'], newCode: ['new_software_quality_maintainability_rating', 'new_maintainability_rating'] },
  vulnerabilities: { overall: ['vulnerabilities'], newCode: ['new_vulnerabilities'] },
  bugs: { overall: ['bugs'], newCode: ['new_bugs'] },
  codeSmells: { overall: ['code_smells'], newCode: ['new_code_smells'] },
  securityHotspots: { overall: ['security_hotspots'], newCode: ['new_security_hotspots'] },
  securityHotspotsReviewed: { overall: ['security_hotspots_reviewed'], newCode: ['new_security_hotspots_reviewed'] },
  securityReviewRating: { overall: ['security_review_rating'], newCode: ['new_security_review_rating'] },
  coverage: { overall: ['coverage'], newCode: ['new_coverage'] },
  duplications: { overall: ['duplicated_lines_density'], newCode: ['new_duplicated_lines_density'] },
  lines: { overall: ['ncloc'], newCode: ['new_lines'] },
  acceptedIssues: { overall: ['accepted_issues'], newCode: ['new_accepted_issues'] },
};

const RATING_KEYS = new Set<MeasureKey>(['securityRating', 'reliabilityRating', 'maintainabilityRating', 'securityReviewRating']);
const RATINGS: readonly SonarRating[] = ['A', 'B', 'C', 'D', 'E'];

function numberValue(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = value.startsWith('{') ? (JSON.parse(value) as { total?: number }).total : Number(value);
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function ratingValue(value: string | undefined): SonarRating | null {
  return RATINGS[Math.round(numberValue(value) ?? 0) - 1] ?? null;
}

function pickMeasures(values: Map<string, string>, scope: keyof MetricCandidates): SonarMeasures {
  const entries = (Object.entries(DETAIL_METRICS) as [MeasureKey, MetricCandidates][]).map(([key, candidates]) => {
    const value = candidates[scope].map((metric) => values.get(metric)).find((found) => found !== undefined);
    return [key, RATING_KEYS.has(key) ? ratingValue(value) : numberValue(value)];
  });
  return Object.fromEntries(entries) as SonarMeasures;
}

function gateValue(value: string | undefined): 'OK' | 'ERROR' | null {
  return value === 'OK' || value === 'ERROR' ? value : null;
}

const PROJECTS_PAGE_SIZE = 100;

export async function listSonarProjects(): Promise<{ total: number; projects: SonarProjectSummary[] }> {
  const known = await serverMetrics();
  const search = await sonarApi<{ paging: { total: number }; components: { key: string; name: string; analysisDate?: string }[] }>(
    `/api/components/search_projects?ps=${PROJECTS_PAGE_SIZE}&s=name&f=analysisDate`,
  );
  const components = search?.components ?? [];
  if (!components.length) return { total: 0, projects: [] };
  const keys = [...new Set(['alert_status', ...Object.values(DETAIL_METRICS).flatMap(({ overall }) => overall)])].filter((key) => known.has(key));
  const query = new URLSearchParams({ projectKeys: components.map((component) => component.key).join(','), metricKeys: keys.join(',') });
  const measures = await sonarApi<{ measures: { metric: string; component: string; value?: string }[] }>(`/api/measures/search?${query}`);
  const byProject = new Map<string, Map<string, string>>();
  for (const measure of measures?.measures ?? []) {
    if (measure.value === undefined) continue;
    if (!byProject.has(measure.component)) byProject.set(measure.component, new Map());
    byProject.get(measure.component)!.set(measure.metric, measure.value);
  }
  return {
    total: search?.paging.total ?? components.length,
    projects: components.map((component) => {
      const values = byProject.get(component.key) ?? new Map<string, string>();
      return {
        key: component.key,
        name: component.name,
        qualityGate: gateValue(values.get('alert_status')),
        analyzedAt: component.analysisDate ?? null,
        measures: pickMeasures(values, 'overall'),
      };
    }),
  };
}

interface MeasureResponse {
  component: { measures: { metric: string; value?: string; period?: { value?: string }; periods?: { value?: string }[] }[] };
  period?: { date?: string };
  periods?: { date?: string }[];
}

interface GateResponse {
  projectStatus: {
    status: string;
    conditions?: { metricKey: string; comparator: string; errorThreshold?: string; actualValue?: string; status: string }[];
    period?: { date?: string };
  };
}

export async function readSonarDetails(projectKey: string): Promise<SonarDetails | undefined> {
  const component = encodeURIComponent(projectKey);
  const known = await serverMetrics();
  const keys = [...new Set(Object.values(DETAIL_METRICS).flatMap(({ overall, newCode }) => [...overall, ...newCode]))].filter((key) => known.has(key));
  const [measures, gate, shown] = await Promise.all([
    sonarApi<MeasureResponse>(`/api/measures/component?component=${component}&metricKeys=${keys.join(',')}&additionalFields=period`),
    sonarApi<GateResponse>(`/api/qualitygates/project_status?projectKey=${component}`),
    sonarApi<{ component: { name?: string; analysisDate?: string } }>(`/api/components/show?component=${component}`),
  ]);
  if (!measures) return undefined;
  const overall = new Map<string, string>();
  const newCode = new Map<string, string>();
  for (const measure of measures.component.measures) {
    if (measure.value !== undefined) overall.set(measure.metric, measure.value);
    const periodValue = measure.period?.value ?? measure.periods?.[0]?.value;
    if (periodValue !== undefined) newCode.set(measure.metric, periodValue);
  }
  return {
    projectKey,
    name: shown?.component.name ?? projectKey,
    qualityGate: gateValue(gate?.projectStatus.status),
    conditions: (gate?.projectStatus.conditions ?? []).map((condition) => ({
      metric: condition.metricKey,
      comparator: condition.comparator,
      threshold: condition.errorThreshold ?? null,
      actual: condition.actualValue ?? null,
      passed: condition.status === 'OK',
    })),
    overall: pickMeasures(overall, 'overall'),
    newCode: newCode.size ? pickMeasures(newCode, 'newCode') : null,
    newCodeSince: measures.period?.date ?? measures.periods?.[0]?.date ?? gate?.projectStatus.period?.date ?? null,
    analyzedAt: shown?.component.analysisDate ?? null,
    url: `${sonarConnection.sonarUrl}/dashboard?id=${component}`,
    issuesUrl: `${sonarConnection.sonarUrl}/project/issues?id=${component}&issueStatuses=OPEN%2CCONFIRMED`,
  };
}

interface IssuesResponse {
  total: number;
  issues: { key: string; rule: string; type?: string; severity?: string; component: string; line?: number; message?: string; effort?: string }[];
  rules?: { key: string; name: string }[];
  facets?: { property: string; values: { val: string; count: number }[] }[];
}

const ISSUES_PAGE_SIZE = 100;

function oneOf<T extends string>(allowed: readonly T[], value: string | undefined): T | null {
  return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : null;
}

export async function searchSonarIssues(projectKey: string, filters: SonarIssueFilters): Promise<SonarIssuePage> {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const query = new URLSearchParams({
    components: projectKey,
    issueStatuses: 'OPEN,CONFIRMED',
    facets: 'types,severities,files',
    additionalFields: 'rules',
    ps: String(ISSUES_PAGE_SIZE),
    p: String(page),
  });
  if (filters.type) query.set('types', filters.type);
  if (filters.severity) query.set('severities', filters.severity);
  if (filters.file) query.set('files', filters.file);
  if (filters.newCode) query.set('inNewCodePeriod', 'true');
  const result = await sonarApi<IssuesResponse>(`/api/issues/search?${query}`);
  if (!result) return { total: 0, page, pageSize: ISSUES_PAGE_SIZE, issues: [], types: {}, severities: {}, files: [] };
  const ruleNames = new Map((result.rules ?? []).map((rule) => [rule.key, rule.name]));
  const facet = (property: string) => result.facets?.find((item) => item.property === property)?.values ?? [];
  const counts = <T extends string>(allowed: readonly T[], property: string) =>
    Object.fromEntries(facet(property).filter((item) => oneOf(allowed, item.val)).map((item) => [item.val, item.count])) as Partial<Record<T, number>>;
  const prefix = `${projectKey}:`;
  return {
    total: result.total,
    page,
    pageSize: ISSUES_PAGE_SIZE,
    issues: result.issues.map((issue) => ({
      key: issue.key,
      rule: issue.rule,
      ruleName: ruleNames.get(issue.rule) ?? null,
      type: oneOf(SONAR_ISSUE_TYPES, issue.type),
      severity: oneOf(SONAR_SEVERITIES, issue.severity),
      file: issue.component.startsWith(prefix) ? issue.component.slice(prefix.length) : null,
      line: issue.line ?? null,
      message: issue.message ?? '',
      effort: issue.effort ?? null,
      url: `${sonarConnection.sonarUrl}/project/issues?id=${encodeURIComponent(projectKey)}&open=${encodeURIComponent(issue.key)}`,
    })),
    types: counts(SONAR_ISSUE_TYPES, 'types'),
    severities: counts(SONAR_SEVERITIES, 'severities'),
    files: facet('files').filter((item) => item.count > 0).map((item) => ({ path: item.val, count: item.count })),
  };
}

export type ScannerOs = 'windows' | 'unix';

export const EXAMPLE_PROJECT_KEY = 'minha-promocao-backend';
export const EXAMPLE_FOLDERS: Record<ScannerOs, string> = { windows: 'C:\\projetos\\minha-promocao', unix: '/home/voce/projetos/minha-promocao' };

/** Regra de chave do SonarQube: letras, números, -, _, . e :, com pelo menos um caractere que não seja número. */
export function projectKeyProblem(key: string): string {
  if (!key) return 'Informe a chave do projeto.';
  if (!/^[A-Za-z0-9_.:-]+$/.test(key)) return 'Use só letras sem acento, números, hífen (-), sublinhado (_), ponto (.) ou dois-pontos (:).';
  if (/^\d+$/.test(key)) return 'A chave precisa ter pelo menos uma letra ou símbolo, não só números.';
  if (key.length > 400) return 'A chave pode ter no máximo 400 caracteres.';
  return '';
}

/** De dentro do container, 127.0.0.1 é o próprio container; no Linux o host.docker.internal só existe com --add-host. */
export function scannerCommands(projectKey: string, folder: string, os: ScannerOs): { setToken: string; run: string } {
  const host = new URL(sonarConnection.sonarUrl);
  if (LOOPBACK_HOSTS.has(host.hostname)) host.hostname = 'host.docker.internal';
  const path = folder.trim().replace(/"/g, '') || EXAMPLE_FOLDERS[os];
  return {
    setToken: os === 'windows' ? '$env:SONAR_TOKEN="cole-aqui-o-seu-token"' : 'export SONAR_TOKEN="cole-aqui-o-seu-token"',
    run: [
      'docker run --rm',
      ...(os === 'unix' ? ['--add-host=host.docker.internal:host-gateway'] : []),
      `-e SONAR_HOST_URL=${host.origin}`,
      '-e SONAR_TOKEN',
      '-e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/usr/src',
      `-v "${path}:/usr/src:ro"`,
      'sonarsource/sonar-scanner-cli',
      `-Dsonar.projectKey=${projectKey || EXAMPLE_PROJECT_KEY}`,
      '-Dsonar.sources=.',
      '-Dsonar.working.directory=/tmp/.scannerwork',
    ].join(' '),
  };
}

export interface ProxyCheck {
  sonarUrl: string;
  version: string | null;
}

/** Sem token: só confirma que o proxy e o SonarQube atrás dele respondem. */
export async function testSonarProxy(proxyUrl: string): Promise<ProxyCheck> {
  const origin = normalizeProxyUrl(proxyUrl);
  const info = await request<{ target?: string }>(origin, '', '/proxy-info');
  if (!info?.target) throw new SonarConnectionError(`O endereço ${origin} respondeu, mas não é o proxy do SonarQube. Confira a porta.`);
  const response = await proxyFetch(origin, '', '/api/system/status');
  if (response.status === 502) throw new SonarConnectionError(`O proxy está rodando, mas o SonarQube em ${info.target} não respondeu. Confira se o container está no ar (docker ps).`);
  let version: string | null = null;
  if (response.status !== 401) {
    if (!response.ok) throw new SonarConnectionError(`O proxy está rodando, mas o SonarQube respondeu HTTP ${response.status}.`);
    const status = (await response.json()) as { status?: string; version?: string };
    if (status.status && status.status !== 'UP') {
      throw new SonarConnectionError(`O proxy está rodando e o SonarQube ainda está subindo (${status.status}). Aguarde 1 a 2 minutos e teste de novo.`);
    }
    version = status.version ?? null;
  }
  if (!sonarConnection.connected) sonarConnection.sonarUrl = info.target;
  return { sonarUrl: info.target, version };
}
