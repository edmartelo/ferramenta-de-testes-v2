import type { IncomingMessage, ServerResponse } from 'node:http';
import { MIN_LABELS_PER_SEVERITY, MIN_LABELS_TO_CLASSIFY, trainedSeverities, warmLabelEmbeddings } from './atendimento-classifier.ts';
import {
  countAtendimentoLabels,
  exportAtendimentoLabels,
  importAtendimentoLabels,
  isSeverity,
  type Severity,
  type StoredAtendimentoLabel,
} from './atendimento-labels.ts';
import { getAuthenticatedRole, getAuthenticatedUserId } from './auth.ts';
import { BadRequestError, readJsonBody, sendJson } from './http-utils.ts';

const FILE_FORMAT = 'ferramenta-de-testes/aprendizado';
const FILE_VERSION = 1;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
/** Tolerância pra relógio adiantado; data além disso venceria toda importação seguinte. */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60_000;

export interface LearningStatus {
  total: number;
  bySeverity: Record<Severity, number>;
  trained: Severity[];
  minLabels: number;
  minPerSeverity: number;
  lastUpdatedAt: string | null;
}

export interface LearningFile {
  format: typeof FILE_FORMAT;
  version: typeof FILE_VERSION;
  exportedAt: string;
  labels: StoredAtendimentoLabel[];
}

function text(value: unknown, max: number, field: string, index: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new BadRequestError(`Correção ${index + 1}: "${field}" inválido.`);
  }
  return value;
}

function parseLearningFile(body: Record<string, unknown>, fallbackUser: string): StoredAtendimentoLabel[] {
  if (body.format !== FILE_FORMAT || body.version !== FILE_VERSION || !Array.isArray(body.labels)) {
    throw new BadRequestError('Arquivo não é um aprendizado exportado por esta ferramenta.');
  }
  return body.labels.map((entry: unknown, index) => {
    const label = (entry ?? {}) as Record<string, unknown>;
    if (!isSeverity(label.severity)) throw new BadRequestError(`Correção ${index + 1}: gravidade inválida.`);
    const updatedAt = new Date(String(label.updatedAt));
    if (Number.isNaN(updatedAt.getTime()) || updatedAt.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) {
      throw new BadRequestError(`Correção ${index + 1}: data inválida.`);
    }
    const tema = typeof label.tema === 'string' ? label.tema.trim().slice(0, 255) || null : null;
    const labeledBy = typeof label.labeledBy === 'string' && label.labeledBy.length <= 32 && label.labeledBy ? label.labeledBy : fallbackUser;
    return {
      promotionName: text(label.promotionName, 255, 'promotionName', index),
      atendimentoId: text(label.atendimentoId, 64, 'atendimentoId', index),
      assunto: typeof label.assunto === 'string' ? label.assunto : '',
      mensagem: text(label.mensagem, 65535, 'mensagem', index),
      severity: label.severity,
      tema,
      labeledBy,
      updatedAt: updatedAt.toISOString(),
    };
  });
}

async function learningStatus(): Promise<LearningStatus> {
  const { total, bySeverity, lastUpdatedAt } = await countAtendimentoLabels();
  return {
    total,
    bySeverity,
    trained: trainedSeverities(total, bySeverity),
    minLabels: MIN_LABELS_TO_CLASSIFY,
    minPerSeverity: MIN_LABELS_PER_SEVERITY,
    lastUpdatedAt,
  };
}

/** Chamador já garantiu `requireAuth`. */
export async function handleLearningRoute(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname === '/api/learning' && req.method === 'GET') return sendJson(res, 200, await learningStatus());
  if (pathname === '/api/learning/export' && req.method === 'GET') {
    const file: LearningFile = { format: FILE_FORMAT, version: FILE_VERSION, exportedAt: new Date().toISOString(), labels: await exportAtendimentoLabels() };
    return sendJson(res, 200, file);
  }
  if (pathname === '/api/learning/import' && req.method === 'POST') {
    // Sobrescreve as correções de todos no banco compartilhado.
    if (getAuthenticatedRole(req) !== 'master') return sendJson(res, 403, { error: 'Só usuários Master importam aprendizado.' });
    const labels = parseLearningFile(await readJsonBody(req, MAX_IMPORT_BYTES), getAuthenticatedUserId(req)!);
    const result = await importAtendimentoLabels(labels);
    if (result.inserted + result.updated > 0) warmLabelEmbeddings(labels);
    return sendJson(res, 200, { ...result, status: await learningStatus() });
  }
  return false;
}
