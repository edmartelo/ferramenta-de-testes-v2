import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJsonFile, writeFileAtomic } from '../src/lib/json-file.ts';
import { PROJECT_ROOT } from '../src/lib/paths.ts';
import { rootEnv } from '../src/lib/root-env.ts';
import { countBySeverity, SEVERITIES, type AtendimentoLabel, type Severity } from './atendimento-labels.ts';
import { maskPersonalData } from './personal-data.ts';
import type { Atendimento } from './test-runner.ts';

export const OLLAMA_URL = rootEnv('OLLAMA_URL') ?? 'http://127.0.0.1:11434';
const EMBED_MODEL = rootEnv('OLLAMA_EMBED_MODEL') ?? 'nomic-embed-text';
const EMBED_TIMEOUT_MS = 5 * 60 * 1000;
/** Mantém o modelo entre os resumos de um mesmo horário agendado e libera a RAM (~11 GB) até o próximo; recarregar leva ~1 min. */
export const OLLAMA_KEEP_ALIVE = '15m';
const EMBED_BATCH = 32;
const MAX_TEXT_CHARS = 2000;

/** Abaixo disso o kNN erra demais; a gravidade fica só com o LLM + exemplos. */
export const MIN_LABELS_TO_CLASSIFY = 30;
/** Com menos correções de uma gravidade os vizinhos quase nunca são dela: o kNN só decide gravidades com pelo menos isso. */
export const MIN_LABELS_PER_SEVERITY = 5;
const K_NEIGHBORS = 7;
export const MIN_VOTE_SHARE = 0.6;
const MIN_NEIGHBOR_SIMILARITY = 0.6;
const MAX_EXAMPLES = 12;

type Vector = number[];

// Prefixo `classification:` recomendado pelo nomic-embed-text; mascarado igual às correções pra comparar no mesmo formato.
function embeddingText(assunto: string, mensagem: string, names: string[] = []): string {
  return `classification: [${maskPersonalData(assunto, names)}] ${maskPersonalData(mensagem, names)}`.slice(0, MAX_TEXT_CHARS);
}

function hashOf(text: string): string {
  return createHash('sha256').update(`${EMBED_MODEL}\n${text}`).digest('hex');
}

async function requestEmbeddings(texts: string[]): Promise<Vector[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, keep_alive: OLLAMA_KEEP_ALIVE }),
  });
  if (res.status === 404) throw new Error(`modelo ${EMBED_MODEL} não instalado (rode "ollama pull ${EMBED_MODEL}")`);
  if (!res.ok) throw new Error(`Ollama respondeu ${res.status} ao gerar embeddings`);
  const { embeddings } = (await res.json()) as { embeddings: Vector[] };
  return embeddings;
}

/** Embeddings com cache num arquivo desta máquina por hash do texto: só o que nunca foi visto vai ao Ollama. */
const EMBEDDINGS_CACHE_PATH = join(PROJECT_ROOT, '.ollama-embeddings.json');
let embeddingsCache: Record<string, Vector> | undefined;

function embeddings(): Record<string, Vector> {
  try {
    embeddingsCache ??= readJsonFile<Record<string, Vector>>(EMBEDDINGS_CACHE_PATH, {});
  } catch {
    embeddingsCache = {};
  }
  return embeddingsCache;
}

async function embed(texts: string[]): Promise<Vector[]> {
  const hashes = texts.map(hashOf);
  const cached = embeddings();
  const missing = [...new Map(texts.map((text, i) => [hashes[i]!, text])).entries()].filter(([hash]) => !cached[hash]);
  for (let start = 0; start < missing.length; start += EMBED_BATCH) {
    const batch = missing.slice(start, start + EMBED_BATCH);
    const vectors = await requestEmbeddings(batch.map(([, text]) => text));
    batch.forEach(([hash], i) => (cached[hash] = vectors[i]!));
    try {
      writeFileAtomic(EMBEDDINGS_CACHE_PATH, JSON.stringify(cached));
    } catch {
      // Sem cache a próxima consulta só demora mais.
    }
  }
  return hashes.map((hash) => cached[hash]!);
}

/** Pré-calcula o embedding de correções recém-salvas, pro próximo resumo não esperar por elas. */
export function warmLabelEmbeddings(labels: Pick<AtendimentoLabel, 'assunto' | 'mensagem'>[]): void {
  embed(labels.map((label) => embeddingText(label.assunto, label.mensagem))).catch(() => {});
}

function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

/** Agrupa atendimentos com texto quase igual (todo par do grupo com similaridade >= `minSimilarity`). */
export async function clusterSimilar(items: Atendimento[], minSimilarity: number): Promise<Atendimento[][]> {
  if (items.length === 0) return [];
  const vectors = await embed(items.map((item) => embeddingText(item.assunto, item.mensagem, [item.participante])));
  const clusters: number[][] = [];
  items.forEach((_, index) => {
    const home = clusters.find((cluster) => cluster.every((member) => cosine(vectors[index]!, vectors[member]!) >= minSimilarity));
    if (home) home.push(index);
    else clusters.push([index]);
  });
  return clusters.map((cluster) => cluster.map((index) => items[index]!));
}

export interface Classification {
  /** Gravidade decidida pelo kNN, só para os atendimentos com voto confiante. */
  predictions: Map<string, Severity>;
  /** Correções mais parecidas pelo sentido, para irem ao prompt como exemplos. */
  examples: AtendimentoLabel[];
  /** Voto das correções parecidas mesmo com o kNN desligado; ausente = nenhuma correção parecida. Alimenta a fila de revisão. */
  votes: Map<string, NeighborVote>;
}

export interface NeighborVote {
  severity: Severity;
  share: number;
}

/** Gravidades que o kNN pode decidir. Com uma só ele vira constante (sempre a classe dominante), então fica desligado. */
export function trainedSeverities(total: number, bySeverity: Record<Severity, number>): Severity[] {
  if (total < MIN_LABELS_TO_CLASSIFY) return [];
  const trained = SEVERITIES.filter((severity) => bySeverity[severity] >= MIN_LABELS_PER_SEVERITY);
  return trained.length >= 2 ? trained : [];
}

/** kNN ponderado por similaridade sobre as correções: "treinar" é só ter a correção salva. */
export async function classifyAtendimentos(items: Atendimento[], labels: AtendimentoLabel[]): Promise<Classification> {
  if (items.length === 0 || labels.length === 0) return { predictions: new Map(), examples: [], votes: new Map() };
  const vectors = await embed([
    ...items.map((item) => embeddingText(item.assunto, item.mensagem, [item.participante])),
    ...labels.map((label) => embeddingText(label.assunto, label.mensagem)),
  ]);
  const itemVectors = vectors.slice(0, items.length);
  const labelVectors = vectors.slice(items.length);

  const predictions = new Map<string, Severity>();
  const votesById = new Map<string, NeighborVote>();
  const trained = trainedSeverities(labels.length, countBySeverity(labels));
  const bestPerLabel = new Array<number>(labels.length).fill(-1);
  items.forEach((item, itemIndex) => {
    const neighbors = labelVectors
      .map((vector, labelIndex) => ({ labelIndex, similarity: cosine(itemVectors[itemIndex]!, vector) }))
      .sort((a, b) => b.similarity - a.similarity);
    for (const { labelIndex, similarity } of neighbors) bestPerLabel[labelIndex] = Math.max(bestPerLabel[labelIndex]!, similarity);
    const nearest = neighbors.slice(0, K_NEIGHBORS).filter((n) => n.similarity >= MIN_NEIGHBOR_SIMILARITY);
    const total = nearest.reduce((sum, n) => sum + n.similarity, 0);
    if (total === 0) return;
    const votes = new Map<Severity, number>();
    for (const n of nearest) votes.set(labels[n.labelIndex]!.severity, (votes.get(labels[n.labelIndex]!.severity) ?? 0) + n.similarity);
    const [severity, weight] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]!;
    votesById.set(item.id, { severity, share: weight / total });
    if (trained.includes(severity) && weight / total >= MIN_VOTE_SHARE) predictions.set(item.id, severity);
  });

  const ranked = labels.map((label, i) => ({ label, score: bestPerLabel[i]! })).sort((a, b) => b.score - a.score);
  const examples = SEVERITIES.flatMap((severity) => ranked.find((entry) => entry.label.severity === severity) ?? []);
  for (const entry of ranked) {
    if (examples.length >= MAX_EXAMPLES) break;
    if (!examples.includes(entry)) examples.push(entry);
  }
  return { predictions, examples: examples.slice(0, MAX_EXAMPLES).map((entry) => entry.label), votes: votesById };
}
