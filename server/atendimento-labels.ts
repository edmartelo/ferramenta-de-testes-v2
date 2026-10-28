import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { db } from '../src/lib/db.ts';
import { readJsonFile } from '../src/lib/json-file.ts';
import { PROJECT_ROOT } from '../src/lib/paths.ts';
import { maskPersonalData } from './personal-data.ts';
import type { Atendimento } from './test-runner.ts';

export const SEVERITIES = ['critica', 'alta', 'media', 'baixa', 'externo'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface AtendimentoLabel {
  promotionName: string;
  atendimentoId: string;
  assunto: string;
  mensagem: string;
  severity: Severity;
  tema: string | null;
}

const MAX_LABELS_READ = 2000;
const MAX_EXAMPLES = 12;
const MIN_WORD_LENGTH = 4;

/** Arquivo das correções de antes do banco: entra na primeira leitura e fica como `.imported`. */
const LEGACY_LABELS_PATH = join(PROJECT_ROOT, '.atendimento-labels.json');
let ready: Promise<Pool> | undefined;

/** Correções do Aprendizado no banco compartilhado, já mascaradas: todas as máquinas veem as mesmas. */
function labelsDb(): Promise<Pool> {
  ready ??= (async () => {
    const pool = await db();
    if (existsSync(LEGACY_LABELS_PATH)) {
      await importInto(pool, readJsonFile<StoredAtendimentoLabel[]>(LEGACY_LABELS_PATH, []));
      renameSync(LEGACY_LABELS_PATH, `${LEGACY_LABELS_PATH}.imported`);
    }
    return pool;
  })().catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

function toLabel(row: RowDataPacket): AtendimentoLabel {
  return {
    promotionName: row.promotion_name,
    atendimentoId: row.atendimento_id,
    assunto: row.assunto,
    mensagem: row.mensagem,
    severity: row.severity,
    tema: row.tema,
  };
}

export function isSeverity(value: unknown): value is Severity {
  return SEVERITIES.includes(value as Severity);
}

export function countBySeverity(labels: AtendimentoLabel[]): Record<Severity, number> {
  return Object.fromEntries(SEVERITIES.map((severity) => [severity, labels.filter((label) => label.severity === severity).length])) as Record<Severity, number>;
}

/** Grava com os dados pessoais mascarados (`names`: nomes a tirar, como o participante) e devolve o que ficou salvo. */
export async function saveAtendimentoLabel(input: AtendimentoLabel, userId: string, names: string[] = []): Promise<AtendimentoLabel> {
  const label = {
    ...input,
    assunto: maskPersonalData(input.assunto, names),
    mensagem: maskPersonalData(input.mensagem, names),
    tema: input.tema && maskPersonalData(input.tema, names),
  };
  await (await labelsDb()).query(
    `INSERT INTO atendimento_labels (promotion_name, atendimento_id, assunto, mensagem, severity, tema, labeled_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE assunto = VALUES(assunto), mensagem = VALUES(mensagem), severity = VALUES(severity), tema = VALUES(tema), labeled_by = VALUES(labeled_by)`,
    [label.promotionName, label.atendimentoId, label.assunto, label.mensagem, label.severity, label.tema, userId],
  );
  return label;
}

export async function listAtendimentoLabels(promotionName: string): Promise<AtendimentoLabel[]> {
  const [rows] = await (await labelsDb()).query<RowDataPacket[]>('SELECT * FROM atendimento_labels WHERE promotion_name = ?', [promotionName]);
  return rows.map(toLabel);
}

/** Limite só aqui: segura o custo do kNN sem deixar de fora correção da própria promoção. */
export async function listOtherPromotionsLabels(promotionName: string): Promise<AtendimentoLabel[]> {
  const [rows] = await (await labelsDb()).query<RowDataPacket[]>(
    'SELECT * FROM atendimento_labels WHERE promotion_name <> ? ORDER BY updated_at DESC LIMIT ?',
    [promotionName, MAX_LABELS_READ],
  );
  return rows.map(toLabel);
}

export interface LabelCounts {
  total: number;
  bySeverity: Record<Severity, number>;
  lastUpdatedAt: string | null;
}

export async function countAtendimentoLabels(): Promise<LabelCounts> {
  const [rows] = await (await labelsDb()).query<RowDataPacket[]>(
    'SELECT severity, COUNT(*) AS total, MAX(updated_at) AS last_updated_at FROM atendimento_labels GROUP BY severity',
  );
  const bySeverity = countBySeverity([]);
  for (const row of rows) if (isSeverity(row.severity)) bySeverity[row.severity] = Number(row.total);
  const lastUpdatedAt = rows.length > 0 ? new Date(Math.max(...rows.map((row) => new Date(row.last_updated_at).getTime()))).toISOString() : null;
  return { total: rows.reduce((sum, row) => sum + Number(row.total), 0), bySeverity, lastUpdatedAt };
}

/** Correção como sai no arquivo de aprendizado: com autor e data, para a importação manter a mais recente. */
export interface StoredAtendimentoLabel extends AtendimentoLabel {
  labeledBy: string;
  updatedAt: string;
}

export interface LabelImportResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

export async function exportAtendimentoLabels(): Promise<StoredAtendimentoLabel[]> {
  const [rows] = await (await labelsDb()).query<RowDataPacket[]>('SELECT * FROM atendimento_labels ORDER BY promotion_name, atendimento_id');
  return rows.map((row) => ({ ...toLabel(row), labeledBy: row.labeled_by, updatedAt: new Date(row.updated_at).toISOString() }));
}

/** Insere o que não existe e, por atendimento, fica a correção mais recente: reimportar o mesmo arquivo não grava nada. */
export async function importAtendimentoLabels(labels: StoredAtendimentoLabel[]): Promise<LabelImportResult> {
  return importInto(await labelsDb(), labels);
}

async function importInto(pool: Pool, labels: StoredAtendimentoLabel[]): Promise<LabelImportResult> {
  const keyOf = (promotionName: string, atendimentoId: string) => `${promotionName}\n${atendimentoId}`;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<RowDataPacket[]>('SELECT promotion_name, atendimento_id, updated_at FROM atendimento_labels FOR UPDATE');
    const current = new Map(rows.map((row) => [keyOf(row.promotion_name, row.atendimento_id), new Date(row.updated_at).getTime()]));
    const newer = new Map<string, StoredAtendimentoLabel>();
    for (const label of labels) {
      const key = keyOf(label.promotionName, label.atendimentoId);
      const updatedAt = new Date(label.updatedAt).getTime();
      const latest = Math.max(current.get(key) ?? -Infinity, newer.has(key) ? new Date(newer.get(key)!.updatedAt).getTime() : -Infinity);
      if (latest < updatedAt) newer.set(key, label);
    }
    const updated = [...newer.keys()].filter((key) => current.has(key)).length;
    const result: LabelImportResult = { inserted: newer.size - updated, updated, unchanged: labels.length - newer.size };
    if (newer.size) {
      await connection.query(
        `INSERT INTO atendimento_labels (promotion_name, atendimento_id, assunto, mensagem, severity, tema, labeled_by, updated_at)
         VALUES ?
         ON DUPLICATE KEY UPDATE assunto = VALUES(assunto), mensagem = VALUES(mensagem), severity = VALUES(severity),
           tema = VALUES(tema), labeled_by = VALUES(labeled_by), updated_at = VALUES(updated_at)`,
        [[...newer.values()].map((label) => [
          label.promotionName, label.atendimentoId, maskPersonalData(label.assunto), maskPersonalData(label.mensagem),
          label.severity, label.tema && maskPersonalData(label.tema), label.labeledBy, new Date(label.updatedAt),
        ])],
      );
    }
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function words(text: string): Set<string> {
  const normalized = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  return new Set(normalized.split(/[^a-z0-9]+/).filter((word) => word.length >= MIN_WORD_LENGTH));
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared === 0 ? 0 : shared / (a.size + b.size - shared);
}

/** Exemplos rotulados mais parecidos (Jaccard de palavras) com algum dos atendimentos, um por gravidade antes do resto. */
export function pickExamples(labels: AtendimentoLabel[], items: Atendimento[]): AtendimentoLabel[] {
  const itemWords = items.map((item) => words(`${item.assunto} ${item.mensagem}`));
  const scored = labels
    .map((label) => {
      const labelWords = words(`${label.assunto} ${label.mensagem}`);
      return { label, score: Math.max(0, ...itemWords.map((item) => similarity(item, labelWords))) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const picked = SEVERITIES.flatMap((severity) => scored.find((entry) => entry.label.severity === severity) ?? []);
  for (const entry of scored) {
    if (picked.length >= MAX_EXAMPLES) break;
    if (!picked.includes(entry)) picked.push(entry);
  }
  return picked.slice(0, MAX_EXAMPLES).map((entry) => entry.label);
}
