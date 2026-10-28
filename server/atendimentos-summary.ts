import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../src/lib/json-file.ts';
import { PROJECT_ROOT } from '../src/lib/paths.ts';
import { rootEnv } from '../src/lib/root-env.ts';
import {
  classifyAtendimentos,
  clusterSimilar,
  MIN_LABELS_PER_SEVERITY,
  MIN_LABELS_TO_CLASSIFY,
  MIN_VOTE_SHARE,
  OLLAMA_KEEP_ALIVE,
  OLLAMA_URL,
  trainedSeverities,
  type NeighborVote,
} from './atendimento-classifier.ts';
import {
  countBySeverity,
  listAtendimentoLabels,
  listOtherPromotionsLabels,
  pickExamples,
  SEVERITIES,
  type AtendimentoLabel,
  type Severity,
} from './atendimento-labels.ts';
import { maskPersonalData } from './personal-data.ts';
import { siteRoute } from '../src/lib/site-url.ts';
import { scannedPromotionPanels, scannedRegistrationLines, type Atendimento } from './test-runner.ts';

export { SEVERITIES, type Severity };

export interface AtendimentosSummaryGroup {
  severity: Severity;
  tema: string;
  resumo: string;
  ids: string[];
}

export interface ReviewSuggestion {
  id: string;
  reason: string;
}

export interface AtendimentosSummary {
  promotionName: string;
  /** `regras` = Ollama indisponível; `note` diz por quê. */
  source: 'ollama' | 'regras';
  note?: string;
  /** Quantos exemplos corrigidos pela equipe foram ao prompt. */
  examples: number;
  /** Atendimentos cuja gravidade veio do classificador treinado com `labels` correções. */
  classified: number;
  labels: number;
  /** Por que o classificador ainda não decide gravidade, quando há correções mas não bastam. */
  learningStatus?: string;
  /** As correções do banco não carregaram: as gravidades saíram sem elas. */
  labelsError?: string;
  /** Atendimentos sem correção em que o sistema tem menos certeza: é onde uma correção ensina mais. */
  reviewFirst: ReviewSuggestion[];
  visaoGeral: string;
  groups: AtendimentosSummaryGroup[];
}

const OLLAMA_MODEL = rootEnv('OLLAMA_MODEL') ?? 'qwen3:14b';
/** Só CPU: ~3 tokens/s e ~50 tokens por atendimento, então 40+ atendimentos passam de 10 min. */
const OLLAMA_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_MESSAGE_CHARS = 1500;
/** Em listas maiores o 14b passa a repetir a mesma gravidade para quase tudo. */
const BATCH_SIZE = 10;

const SYSTEM_PROMPT = `Você analisa atendimentos (SAC) de uma promoção comercial brasileira.
A equipe é técnica: só age quando o sistema da promoção falha. O que o SAC resolve sozinho é "externo".
Gravidade:
- critica: participante não consegue se cadastrar ou cadastrar cupom/nota fiscal/código na promoção, pelo site ou pelo WhatsApp; mensagem de erro ao cadastrar; site ou sistema com erro ou fora do ar.
- alta: saldo, pontos, selos ou números da sorte calculados errado pelo sistema; ameaça de Procon, Reclame Aqui ou processo.
- media: dificuldade de login ou senha.
- externo: tudo que o SAC resolve sem a equipe técnica — dúvidas sobre a mecânica, regulamento, prazos, produtos participantes, lojas aceitas, prêmios, medidas ou uso do produto; prazo ou status de análise de cupom; cupom reprovado; alterar ou excluir cadastro; código de rastreio; envio ou entrega de prêmio ou brinde (não recebido, atrasado); pagamento de cashback, reembolso ou Pix; produto ou prêmio avariado, quebrado ou estragado; disponibilidade de prêmio, estoque esgotado; voucher, loja, banco, operadora ou outra empresa parceira (ex.: Mercado Livre); denúncia de fraude ou de irregularidade de outros participantes.
- baixa: reclamação ou desabafo sem pedido concreto, elogio, agradecimento, sugestão ou mensagem sem conteúdo.
"itens": um por atendimento, com id, severity, tema (2 a 5 palavras) e duvida (true quando o participante pergunta como a promoção funciona, sem relatar falha). Atendimentos sobre o mesmo problema ou a mesma dúvida usam exatamente o mesmo texto de tema.
"temas": um por tema distinto usado em "itens", com resumo de 1 a 2 frases do que os participantes relatam.
Escreva em português, objetivo, sem nomes, e-mails, telefones ou CPFs.`;

interface OllamaAnswer {
  itens: { id: string; severity: Severity; tema: string; duvida?: boolean }[];
  temas: { tema: string; resumo: string }[];
}

/** `enum` + `minItems`/`maxItems` forçam o modelo a classificar todo atendimento com id real. */
function responseSchema(ids: string[]) {
  return {
    type: 'object',
    properties: {
      itens: {
        type: 'array',
        minItems: ids.length,
        maxItems: ids.length,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: ids },
            severity: { type: 'string', enum: SEVERITIES },
            tema: { type: 'string' },
            duvida: { type: 'boolean' },
          },
          required: ['id', 'severity', 'tema', 'duvida'],
        },
      },
      temas: {
        type: 'array',
        items: { type: 'object', properties: { tema: { type: 'string' }, resumo: { type: 'string' } }, required: ['tema', 'resumo'] },
      },
    },
    required: ['itens', 'temas'],
  };
}

const RULES: { severity: Severity; tema: string; pattern: RegExp }[] = [
  {
    severity: 'critica',
    tema: 'Falha de cadastro ou sistema',
    pattern: /nao (consig|consegu|da|deixa|aceita|cadastr|carreg|funcion)|\berro\b|travad|fora do ar|invalid/,
  },
  {
    severity: 'externo',
    tema: 'Entrega, estoque, cashback ou avaria',
    pattern: /rastre|entreg|envio|enviad|correio|transportador|nao (recebi|chegou)|cashback|pix|avariad|quebrad|estragad|danificad|esgotad|estoque|disponive|resgat/,
  },
  {
    severity: 'alta',
    tema: 'Saldo ou reclamação formal',
    pattern: /saldo|ponto|selo|procon|reclame aqui|processo|advogad/,
  },
  { severity: 'media', tema: 'Login ou senha', pattern: /senha|login/ },
  { severity: 'externo', tema: 'Cupom, dados ou dúvidas', pattern: /reprovad|recusad|analise|alter|troc|corrig|exclu|duvida|\?/ },
];

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function classifyByRules(items: Atendimento[]): AtendimentosSummaryGroup[] {
  const groups = new Map<string, AtendimentosSummaryGroup>();
  for (const item of items) {
    const text = normalize(`${item.assunto} ${item.mensagem}`);
    const rule = RULES.find((r) => r.pattern.test(text)) ?? { severity: 'baixa' as const, tema: 'Dúvidas e outros' };
    const group = groups.get(rule.tema) ?? { severity: rule.severity, tema: rule.tema, resumo: '', ids: [] };
    group.ids.push(item.id);
    groups.set(rule.tema, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    resumo: `${group.ids.length} atendimento(s) classificado(s) por palavra-chave — confira as mensagens.`,
  }));
}

/** Progresso: até 70% conforme os `itens` saem do modelo, até 98% conforme os resumos de `temas`. */
function progressOf(content: string, total: number): number {
  const temasAt = content.indexOf('"temas"');
  if (temasAt === -1) return Math.min(70, Math.round(((content.match(/"id"\s*:/g)?.length ?? 0) / total) * 70));
  const distinct = new Set([...content.slice(0, temasAt).matchAll(/"tema"\s*:\s*"([^"]*)"/g)].map((m) => normalize(m[1]!.trim()))).size;
  const resumos = content.slice(temasAt).match(/"resumo"\s*:/g)?.length ?? 0;
  return Math.min(98, 70 + Math.round((resumos / Math.max(distinct, 1)) * 28));
}

function formatAtendimento(assunto: string, mensagem: string): string {
  return `[${assunto}] ${mensagem.slice(0, MAX_MESSAGE_CHARS)}`;
}

function examplesPrompt(examples: AtendimentoLabel[]): string {
  if (examples.length === 0) return '';
  const lines = examples.map(
    (example) => `${formatAtendimento(example.assunto, example.mensagem)}\n=> severity: ${example.severity}${example.tema ? `, tema: ${example.tema}` : ''}`,
  );
  return `\n\nExemplos já classificados pela equipe. Siga o mesmo critério em casos parecidos:\n\n${lines.join('\n\n')}`;
}

/** Lotes do mais antigo pro mais novo (atendimento novo só invalida o último no cache), cada um com os temas anteriores. */
async function askOllamaInBatches(
  items: Atendimento[],
  examples: AtendimentoLabel[],
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<OllamaAnswer> {
  const ordered = [...items].reverse();
  const batches = Array.from({ length: Math.ceil(ordered.length / BATCH_SIZE) }, (_, i) => ordered.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE));
  const merged: OllamaAnswer = { itens: [], temas: [] };
  for (const [index, batch] of batches.entries()) {
    const knownTemas = [...new Set(merged.temas.map((t) => String(t.tema).trim()))];
    const answer = await askOllama(batch, examples, knownTemas, (percent) => onProgress(Math.round((index * 100 + percent) / batches.length)), signal);
    merged.itens.push(...(Array.isArray(answer.itens) ? answer.itens : []));
    merged.temas.push(...(Array.isArray(answer.temas) ? answer.temas : []));
  }
  return merged;
}

/** Status de erro vira exceção: o corpo de erro do Ollama não pode passar por resposta vazia. */
async function postChat(request: object, signal: AbortSignal): Promise<Response> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ ...request, keep_alive: OLLAMA_KEEP_ALIVE }),
  });
  if (res.status === 404) throw new Error(`modelo ${OLLAMA_MODEL} não instalado (rode "ollama pull ${OLLAMA_MODEL}")`);
  if (!res.ok) throw new Error(`Ollama respondeu ${res.status}`);
  return res;
}

function failureReason(error: unknown): string {
  return error instanceof Error && error.cause instanceof Error ? error.cause.message : (error as Error).message;
}

async function askOllama(
  items: Atendimento[],
  examples: AtendimentoLabel[],
  knownTemas: string[],
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<OllamaAnswer> {
  const temasPrompt = knownTemas.length > 0 ? `Temas já usados (reutilize exatamente o mesmo texto quando for o mesmo problema): ${knownTemas.join('; ')}\n\n` : '';
  const userPrompt = temasPrompt + items.map((item) => `#${item.id} ${formatAtendimento(item.assunto, item.mensagem)}`).join('\n\n');
  const request = {
    model: OLLAMA_MODEL,
    stream: true,
    format: responseSchema(items.map((item) => item.id)),
    options: { temperature: 0, num_ctx: 16384 },
    // O qwen3 raciocina antes de responder por padrão: na CPU isso multiplica o tempo sem melhorar a classificação.
    ...(OLLAMA_MODEL.startsWith('qwen3') ? { think: false } : {}),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + examplesPrompt(examples) },
      { role: 'user', content: userPrompt },
    ],
  };
  const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const cached = cachedAnswer(requestHash);
  if (cached) return cached;
  const timeout = AbortSignal.timeout(OLLAMA_TIMEOUT_MS);
  const res = await postChat(request, signal ? AbortSignal.any([signal, timeout]) : timeout);
  if (!res.body) throw new Error(`Ollama respondeu ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let percent = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as { message?: { content?: string }; error?: string };
        if (event.error) throw new Error(event.error);
        content += event.message?.content ?? '';
      }
      const next = progressOf(content, items.length);
      if (next !== percent) onProgress((percent = next));
    }
  } finally {
    // Com o leitor aberto o Ollama segue gerando a resposta que ninguém vai ler.
    reader.cancel().catch(() => {});
  }
  const answer = JSON.parse(content) as OllamaAnswer;
  saveAnswer(requestHash, answer);
  return answer;
}

/** Respostas trazem texto dos participantes sem máscara: ficam num arquivo desta máquina, nunca no banco. */
const ANSWERS_CACHE_PATH = join(PROJECT_ROOT, '.ollama-cache.json');
let answersCache: Record<string, unknown> | undefined;

function answers(): Record<string, unknown> {
  try {
    answersCache ??= readJsonFile<Record<string, unknown>>(ANSWERS_CACHE_PATH, {});
  } catch {
    answersCache = {};
  }
  return answersCache;
}

/** Com temperatura 0 o mesmo pedido dá a mesma resposta: atendimentos e exemplos iguais aos de uma consulta anterior não voltam ao modelo. */
function cachedAnswer<T = OllamaAnswer>(requestHash: string): T | null {
  return (answers()[requestHash] as T | undefined) ?? null;
}

function saveAnswer(requestHash: string, answer: unknown): void {
  answers()[requestHash] = answer;
  try {
    writeJsonFile(ANSWERS_CACHE_PATH, answersCache);
  } catch {
    // Sem cache a próxima consulta só demora mais.
  }
}

/** Modelo confirma quais perguntas do grupo são a mesma dúvida: tema e embedding sozinhos juntam perguntas diferentes. */
async function askSameDoubt(items: Atendimento[]): Promise<string[][]> {
  const ids = items.map((item) => item.id);
  const request = {
    model: OLLAMA_MODEL,
    stream: false,
    format: {
      type: 'object',
      properties: { grupos: { type: 'array', items: { type: 'array', items: { type: 'string', enum: ids } } } },
      required: ['grupos'],
    },
    options: { temperature: 0, num_ctx: 8192 },
    ...(OLLAMA_MODEL.startsWith('qwen3') ? { think: false } : {}),
    messages: [
      {
        role: 'system',
        content:
          'Agrupe as perguntas que são exatamente a mesma dúvida (a mesma pergunta, com outras palavras). Perguntas diferentes sobre o mesmo assunto ficam em grupos separados. "grupos": listas de ids; cada id em um grupo só.',
      },
      { role: 'user', content: items.map((item) => `#${item.id} ${formatAtendimento(item.assunto, item.mensagem)}`).join('\n\n') },
    ],
  };
  const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const cached = cachedAnswer<{ grupos: string[][] }>(requestHash);
  const answer =
    cached ??
    ((await (await postChat(request, AbortSignal.timeout(OLLAMA_TIMEOUT_MS))).json()) as { message?: { content?: string } }).message?.content;
  const parsed = typeof answer === 'string' ? (JSON.parse(answer) as { grupos: string[][] }) : answer;
  if (!cached && parsed) saveAnswer(requestHash, parsed);
  const seen = new Set<string>();
  return (parsed?.grupos ?? []).map((group) => group.map(String).filter((id) => ids.includes(id) && !seen.has(id) && seen.add(id)));
}

/** Agrupa por tema com a gravidade mais alta; id inválido é ignorado e o que o modelo pulou vai pras regras. */
/** O 14b acerta o tema mas às vezes dá "alta"/"critica" a assunto fora da alçada (ex.: "disponibilidade de prêmio" com selo na mensagem, denúncia de fraude). */
const EXTERNAL_TEMA = /rastre|entrega|envio|correio|cashback|pix|avari|quebrad|danific|esgot|estoque|disponibilidade|reposicao|fraude|irregular|nota fria|notas frias/;

function groupAnswer(items: Atendimento[], answer: OllamaAnswer): AtendimentosSummaryGroup[] {
  const participantOf = new Map(items.map((item) => [item.id, item.participante]));
  const used = new Set<string>();
  const resumos = new Map((Array.isArray(answer.temas) ? answer.temas : []).map((t) => [normalize(String(t.tema).trim()), String(t.resumo).trim()]));
  const groups = new Map<string, AtendimentosSummaryGroup>();
  for (const item of Array.isArray(answer.itens) ? answer.itens : []) {
    const id = String(item.id);
    if (!participantOf.has(id) || used.has(id)) continue;
    used.add(id);
    const tema = String(item.tema ?? '').trim() || 'Sem tema';
    const key = normalize(tema);
    const severity = EXTERNAL_TEMA.test(key) ? 'externo' : SEVERITIES.includes(item.severity) ? item.severity : 'media';
    const group = groups.get(key) ?? { severity, tema, resumo: resumos.get(key) ?? '', ids: [] };
    if (SEVERITIES.indexOf(severity) < SEVERITIES.indexOf(group.severity)) group.severity = severity;
    group.ids.push(id);
    groups.set(key, group);
  }
  // O modelo repete o mesmo tema em vários atendimentos (e entre lotes): mascara com o nome de todos os participantes do grupo.
  const answered = [...groups.values()].map((group) => {
    const names = group.ids.map((id) => participantOf.get(id)!);
    const tema = maskPersonalData(group.tema, names);
    return { ...group, tema, resumo: maskPersonalData(group.resumo, names) || `${group.ids.length} atendimento(s) sobre ${tema}.` };
  });
  return [...answered, ...classifyByRules(items.filter((item) => !used.has(item.id)))];
}

function bySeverity(groups: AtendimentosSummaryGroup[]): AtendimentosSummaryGroup[] {
  return groups.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

type Override = { severity: Severity; tema: string | null };

/** Tira o atendimento do grupo original e põe no da gravidade/tema impostos (correção da equipe ou classificador). */
function applyOverrides(groups: AtendimentosSummaryGroup[], overrides: Map<string, Override>): AtendimentosSummaryGroup[] {
  const keyOf = (severity: Severity, tema: string) => `${severity}|${normalize(tema.trim())}`;
  const result = new Map<string, AtendimentosSummaryGroup>();
  const moved: { id: string; override: Override; from: AtendimentosSummaryGroup }[] = [];
  for (const group of groups) {
    const kept = group.ids.filter((id) => !overrides.has(id));
    for (const id of group.ids) if (overrides.has(id)) moved.push({ id, override: overrides.get(id)!, from: group });
    if (kept.length === 0) continue;
    const key = keyOf(group.severity, group.tema);
    const existing = result.get(key);
    if (existing) existing.ids.push(...kept);
    else result.set(key, { ...group, ids: kept });
  }
  for (const { id, override, from } of moved) {
    const tema = override.tema || from.tema;
    const key = keyOf(override.severity, tema);
    const target = result.get(key) ?? { severity: override.severity, tema, resumo: from.resumo, ids: [] };
    target.ids.push(id);
    result.set(key, target);
  }
  return [...result.values()];
}

interface Learned {
  overrides: Map<string, Override>;
  /** Ids corrigidos pela equipe: nenhuma regra automática muda a gravidade deles. */
  labeled: Set<string>;
  /** Gravidade do kNN; aplicada depois do LLM, nunca rebaixando um crítico dele. */
  predicted: Map<string, Severity>;
  votes: Map<string, NeighborVote>;
  labelCounts: Record<Severity, number>;
  examples: AtendimentoLabel[];
  labels: number;
  learningStatus?: string;
  labelsError?: string;
  note?: string;
}

const MAX_REVIEW_SUGGESTIONS = 5;
const SEVERITY_NAMES: Record<Severity, string> = { critica: 'grave', alta: 'alta', media: 'média', baixa: 'baixa', externo: 'fora da alçada' };

/** Revisa primeiro onde Ollama e correções discordam, depois correções divididas, depois sem correção; empate: classe mais rara. */
function reviewFirst(classified: AtendimentosSummaryGroup[], learned: Learned, source: AtendimentosSummary['source']): ReviewSuggestion[] {
  const who = source === 'ollama' ? 'Ollama' : 'Palavras-chave';
  const candidates = classified.flatMap((group) =>
    group.ids
      .filter((id) => !learned.labeled.has(id))
      .map((id) => {
        const vote = learned.votes.get(id);
        const said = SEVERITY_NAMES[group.severity];
        if (vote && vote.share >= MIN_VOTE_SHARE && vote.severity !== group.severity) {
          return { id, tier: 0, share: vote.share, severity: group.severity, reason: `${who}: ${said}; correções parecidas dizem ${SEVERITY_NAMES[vote.severity]}.` };
        }
        if (vote && vote.share < MIN_VOTE_SHARE) {
          return { id, tier: 1, share: vote.share, severity: group.severity, reason: `${who}: ${said}; correções parecidas estão divididas.` };
        }
        if (!vote) return { id, tier: 2, share: 0, severity: group.severity, reason: `${who}: ${said}; nenhuma correção parecida ainda.` };
        return undefined;
      })
      .filter((candidate) => candidate !== undefined),
  );
  return candidates
    .sort((a, b) => a.tier - b.tier || learned.labelCounts[a.severity] - learned.labelCounts[b.severity] || a.share - b.share)
    .slice(0, MAX_REVIEW_SUGGESTIONS)
    .map(({ id, reason }) => ({ id, reason }));
}

function learningStatus(labels: AtendimentoLabel[]): string | undefined {
  if (labels.length === 0 || trainedSeverities(labels.length, countBySeverity(labels)).length > 0) return undefined;
  const counts = SEVERITIES.map((severity) => [severity, labels.filter((label) => label.severity === severity).length] as const)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${severity} ${count}`);
  return `Classificador aprendendo: ${labels.length} correções (${counts.join(', ')}). Decide a gravidade com ${MIN_LABELS_TO_CLASSIFY} no total e ${MIN_LABELS_PER_SEVERITY} em pelo menos 2 gravidades.`;
}

/** Correções da própria consulta sempre vencem; o classificador decide a gravidade do resto quando confiante. */
async function learnFromLabels(promotionName: string, items: Atendimento[]): Promise<Learned> {
  let own: AtendimentoLabel[];
  let otherPromotions: AtendimentoLabel[];
  try {
    [own, otherPromotions] = await Promise.all([listAtendimentoLabels(promotionName), listOtherPromotionsLabels(promotionName)]);
  } catch (error) {
    return {
      overrides: new Map(),
      labeled: new Set(),
      predicted: new Map(),
      votes: new Map(),
      labelCounts: countBySeverity([]),
      examples: [],
      labels: 0,
      labelsError: (error as Error).message,
    };
  }
  const participantOf = new Map(items.map((item) => [item.id, item.participante]));
  const isCurrent = (label: AtendimentoLabel) => label.promotionName === promotionName && participantOf.has(label.atendimentoId);
  const others = [...own.filter((label) => !isCurrent(label)), ...otherPromotions];
  // O tema da correção costuma ser copiado do modelo e vai ao WhatsApp: mascara como os do resumo.
  const overrides = new Map<string, Override>(
    own
      .filter(isCurrent)
      .map((label) => [label.atendimentoId, { severity: label.severity, tema: label.tema && maskPersonalData(label.tema, [participantOf.get(label.atendimentoId)!]) }]),
  );
  const labeled = new Set(overrides.keys());
  const pending = items.filter((item) => !overrides.has(item.id));
  const status = learningStatus(others);
  const labelCounts = countBySeverity(others);
  try {
    const { predictions, examples, votes } = await classifyAtendimentos(pending, others);
    return { overrides, labeled, predicted: predictions, votes, labelCounts, examples, labels: others.length, learningStatus: status };
  } catch (error) {
    return {
      overrides,
      labeled,
      predicted: new Map(),
      votes: new Map(),
      labelCounts,
      examples: pickExamples(others, pending),
      labels: others.length,
      learningStatus: status,
      note: `Classificador indisponível (${(error as Error).message}) — exemplos escolhidos por palavras.`,
    };
  }
}

/** Último resumo de cada promoção, para o envio ao WhatsApp não depender de texto vindo do navegador. */
const lastSummaries = new Map<string, AtendimentosSummary>();

export function rememberSummary(summary: AtendimentosSummary): void {
  lastSummaries.set(summary.promotionName, summary);
}

const MAX_WHATSAPP_IDS = 3;

/** Só esses níveis vão ao WhatsApp, nesta ordem. */
const WHATSAPP_SEVERITIES: { severity: Severity; title: string }[] = [
  { severity: 'critica', title: '🔴 *Crítico*' },
  { severity: 'alta', title: '🟠 *Alta*' },
];

/** Bloco de uma promoção: nome, depois cada nível com uma linha por tema (motivo + primeiros IDs) e o link. */
function promotionWhatsAppLines(summary: AtendimentosSummary, panelUrl: string | undefined): string[] {
  const levels = WHATSAPP_SEVERITIES.flatMap(({ severity, title }) => {
    const groups = summary.groups.filter((group) => group.severity === severity);
    if (groups.length === 0) return [];
    const lines = groups.map((group) => {
      const more = group.ids.length > MAX_WHATSAPP_IDS ? '…' : '';
      return `• ${group.tema} (${group.ids.length}): ID atend. ${group.ids.slice(0, MAX_WHATSAPP_IDS).map((id) => `#${id}`).join(', ')}${more}`;
    });
    return ['', title, ...lines];
  });
  const warning = summary.labelsError ? ['', '⚠️ Correções do Aprendizado indisponíveis: gravidades sem elas.'] : [];
  if (levels.length === 0 && warning.length === 0) return [];
  return [`*${summary.promotionName}*`, ...warning, ...levels, ...(panelUrl ? ['', `🔗 ${siteRoute(panelUrl, 'atendimentos')}`] : [])];
}

export function summaryWhatsAppLines(promotionNames: string[]): string[] {
  const summaries = promotionNames.flatMap((name) => lastSummaries.get(name) ?? []);
  if (summaries.length === 0) return [];
  const panels = new Map(scannedPromotionPanels().map((panel) => [panel.promotionName, panel.panelUrl]));
  const blocks = summaries
    .map((summary) => promotionWhatsAppLines(summary, panels.get(summary.promotionName)))
    .filter((block) => block.length > 0);
  if (blocks.length === 0) return ['✅ Atendimentos: nada crítico.'];
  return blocks.flatMap((block, index) => (index === 0 ? block : ['', '---', '', ...block]));
}

export type AtendimentosSummaryEvent =
  | { type: 'progress'; percent: number }
  | ({ type: 'end'; success: true } & AtendimentosSummary)
  | { type: 'end'; success: false; error: string };

/** Finalizados e os que esperam o participante já tiveram resposta do SAC; só os pendentes com a equipe entram no resumo. */
function isAwaitingTeam(item: Atendimento): boolean {
  return normalize(item.status).replace(/\s+/g, ' ').trim() === 'aguardando resposta do atendimento';
}

export async function summarizeAtendimentos(
  promotionName: string,
  scanned: Atendimento[],
  onProgress: (percent: number) => void = () => {},
  signal?: AbortSignal,
): Promise<AtendimentosSummary> {
  const items = scanned.filter(isAwaitingTeam);
  if (items.length === 0) {
    return { promotionName, source: 'regras', examples: 0, classified: 0, labels: 0, reviewFirst: [], visaoGeral: 'Nenhum atendimento aguardando resposta do atendimento no período.', groups: [] };
  }
  const learned = await learnFromLabels(promotionName, items);
  const finish = async (
    source: AtendimentosSummary['source'],
    examples: number,
    classified: AtendimentosSummaryGroup[],
    doubtIds: Set<string>,
    note: string | undefined,
  ): Promise<AtendimentosSummary> => {
    const critical = new Set(classified.filter((group) => group.severity === 'critica').flatMap((group) => group.ids));
    const overrides = new Map<string, Override>();
    for (const [id, severity] of learned.predicted) if (!critical.has(id) || severity === 'critica') overrides.set(id, { severity, tema: null });
    const predictedCount = overrides.size;
    for (const [id, override] of learned.overrides) overrides.set(id, override);
    const escalated = await escalateRepeatedDoubts(items, applyOverrides(classified, overrides), doubtIds, learned.labeled);
    const confirmed = confirmCritical(promotionName, items, escalated.groups);
    const groups = bySeverity(confirmed.groups);
    const labelsNote = learned.labelsError && `Correções do Aprendizado indisponíveis (${learned.labelsError}) — gravidades sem elas.`;
    const notes = [labelsNote, note, escalated.note, confirmed.note].filter(Boolean).join(' ');
    return {
      promotionName,
      source,
      note: notes || undefined,
      examples,
      classified: predictedCount,
      labels: learned.labels,
      learningStatus: learned.learningStatus,
      labelsError: learned.labelsError,
      reviewFirst: reviewFirst(classified, learned, source),
      visaoGeral: overview(groups),
      groups,
    };
  };
  try {
    const answer = await askOllamaInBatches(items, learned.examples, onProgress, signal);
    const doubtIds = new Set(answer.itens.filter((item) => item.duvida === true).map((item) => String(item.id)));
    return await finish('ollama', learned.examples.length, groupAnswer(items, answer), doubtIds, learned.note);
  } catch (error) {
    if (signal?.aborted) throw error;
    return await finish('regras', 0, classifyByRules(items), new Set(), `Ollama indisponível (${failureReason(error)}) — classificação só por palavras-chave.`);
  }
}

const REGISTRATION_SILENCE_MS = 10 * 60_000;
/** Cupom entra o tempo todo: sem cupom cadastrado nessa janela antes do scan, o canal está parado. */
const COUPON_SILENCE_MS = 60 * 60_000;
/** A mesma dúvida vinda de tantos participantes diferentes sugere falha no funcionamento da promoção. */
const REPEATED_DOUBT_PARTICIPANTS = 3;
/** Pré-filtro por embedding antes de o modelo confirmar se é a mesma dúvida; o tema do modelo sozinho é genérico demais. */
const SAME_DOUBT_SIMILARITY = 0.85;

/** O Monitor de Promoções mostra hora de Brasília; o container Docker roda em UTC. A data de recebimento vem com quebra de linha. */
function parsePanelTime(value: string): number | undefined {
  const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  return match ? Date.parse(`${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:${match[6]}-03:00`) : undefined;
}

/** Último cadastro do mesmo tipo (cupom ou participante) e canal (WhatsApp ou site) do relato; sem linha do canal, qualquer canal do tipo. */
function lastRegistrationAt(item: Atendimento, lines: { label: string; value: string }[]): { coupon: boolean; at: number } | undefined {
  const text = normalize(`${item.assunto} ${item.mensagem}`);
  const coupon = /cupo|nota|codigo/.test(text);
  const kind = coupon ? /cadastro.*cupo/ : /cadastro.*particip/;
  const channel = /whats|zap|bot/.test(text) ? /whats/ : /site/;
  const ofKind = lines.filter((line) => kind.test(normalize(line.label)));
  const ofChannel = ofKind.filter((line) => channel.test(normalize(line.label)));
  const times = (ofChannel.length > 0 ? ofChannel : ofKind).flatMap((line) => parsePanelTime(line.value) ?? []);
  return times.length > 0 ? { coupon, at: Math.max(...times) } : undefined;
}

/** Crítica ou alta, corrigida ou não, com cadastro do mesmo tipo e canal depois da reclamação é falso alerta: vai pra externo. */
function confirmCritical(
  promotionName: string,
  items: Atendimento[],
  groups: AtendimentosSummaryGroup[],
): { groups: AtendimentosSummaryGroup[]; note?: string } {
  const registrations = scannedRegistrationLines(promotionName);
  if (!registrations) return { groups };
  const byId = new Map(items.map((item) => [item.id, item]));
  const scannedAt = registrations.scannedAt.getTime();
  const ignored = new Map<string, Override>();
  for (const id of groups.filter((group) => group.severity === 'critica' || group.severity === 'alta').flatMap((group) => group.ids)) {
    const item = byId.get(id);
    const last = item && lastRegistrationAt(item, registrations.lines);
    if (!item || last === undefined) continue;
    const receivedAt = parsePanelTime(item.dataRecebimento);
    const working = receivedAt !== undefined
      ? last.at > receivedAt
      : scannedAt - last.at <= (last.coupon ? COUPON_SILENCE_MS : REGISTRATION_SILENCE_MS);
    if (working) ignored.set(id, { severity: 'externo', tema: null });
  }
  if (ignored.size === 0) return { groups };
  const time = registrations.scannedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  return {
    groups: applyOverrides(groups, ignored),
    note: `Recorrências das ${time}: ${ignored.size} relato(s) de falha de cadastro foram para fora da alçada (houve cadastro depois da reclamação).`,
  };
}

/** Mesma dúvida de 3+ participantes vira crítica; dúvida isolada média ou baixa vira externo; correções não mudam. */
async function escalateRepeatedDoubts(
  items: Atendimento[],
  groups: AtendimentosSummaryGroup[],
  doubtIds: Set<string>,
  labeled: Set<string>,
): Promise<{ groups: AtendimentosSummaryGroup[]; note?: string }> {
  if (doubtIds.size === 0) return { groups };
  const byId = new Map(items.map((item) => [item.id, item]));
  const byTema = new Map<string, { tema: string; items: Atendimento[] }>();
  for (const group of groups) {
    const key = normalize(group.tema.trim());
    const entry = byTema.get(key) ?? { tema: group.tema, items: [] };
    entry.items.push(...group.ids.filter((id) => doubtIds.has(id)).flatMap((id) => byId.get(id) ?? []));
    byTema.set(key, entry);
  }
  const severityOf = new Map(groups.flatMap((group) => group.ids.map((id) => [id, group.severity] as const)));
  const overrides = new Map<string, Override>();
  const temas: string[] = [];
  const unchecked: string[] = [];
  let uncheckedReason = '';
  for (const { tema, items: doubts } of byTema.values()) {
    let clusters: Atendimento[][];
    try {
      clusters = await clusterSimilar(doubts, SAME_DOUBT_SIMILARITY);
    } catch {
      clusters = doubts.map((item) => [item]);
    }
    const participantsOf = (list: Atendimento[]) => new Set(list.map((item) => normalize(item.participante.trim() || `#${item.id}`)));
    const confirmed: Atendimento[][] = [];
    for (const cluster of clusters) {
      if (participantsOf(cluster).size < REPEATED_DOUBT_PARTICIPANTS) {
        confirmed.push(cluster);
        continue;
      }
      try {
        const sameIds = await askSameDoubt(cluster);
        const grouped = new Set(sameIds.flat());
        confirmed.push(...sameIds.map((ids) => cluster.filter((item) => ids.includes(item.id))), ...cluster.filter((item) => !grouped.has(item.id)).map((item) => [item]));
      } catch (error) {
        unchecked.push(`${tema} (${participantsOf(cluster).size} participantes)`);
        uncheckedReason = failureReason(error);
        confirmed.push(...cluster.map((item) => [item]));
      }
    }
    for (const cluster of confirmed) {
      const participants = participantsOf(cluster);
      const repeated = participants.size >= REPEATED_DOUBT_PARTICIPANTS;
      for (const item of cluster) {
        if (labeled.has(item.id)) continue;
        if (repeated) overrides.set(item.id, { severity: 'critica', tema });
        else if (severityOf.get(item.id) === 'media' || severityOf.get(item.id) === 'baixa') overrides.set(item.id, { severity: 'externo', tema });
      }
      if (repeated && cluster.some((item) => !labeled.has(item.id))) temas.push(`${tema} (${participants.size} participantes)`);
    }
  }
  const notes = [
    temas.length > 0 ? `Dúvida repetida por vários participantes virou crítica, pode ser falha na promoção: ${temas.join(', ')}.` : '',
    unchecked.length > 0 ? `Ollama não conferiu se é a mesma dúvida (${uncheckedReason}), então não virou crítica: ${unchecked.join(', ')}.` : '',
  ].filter(Boolean);
  return { groups: overrides.size > 0 ? applyOverrides(groups, overrides) : groups, note: notes.join(' ') || undefined };
}

/** Montada dos grupos: com lotes nenhuma chamada ao modelo vê o conjunto todo. */
function overview(groups: AtendimentosSummaryGroup[]): string {
  const count = (list: AtendimentosSummaryGroup[]) => list.reduce((sum, group) => sum + group.ids.length, 0);
  const critical = count(groups.filter((group) => group.severity === 'critica'));
  const main = [...groups]
    .sort((a, b) => b.ids.length - a.ids.length)
    .slice(0, 3)
    .map((group) => `${group.tema} (${group.ids.length})`);
  return `${count(groups)} atendimento(s); ${critical} grave(s). Principais: ${main.join(', ')}.`;
}
