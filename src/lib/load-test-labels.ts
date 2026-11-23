import type { LoadEnv, LoadRunStatus } from '../api';

export const LOAD_ENV_LABELS: Record<LoadEnv, string> = { dev: 'Dev', staging: 'Homolog' };

export const LOAD_ENV_HINTS: Record<LoadEnv, string> = {
  dev: 'Só para validar o plano no servidor local: os números não valem como medição.',
  staging: 'Medição: servidor compartilhado com as agências, combine o horário antes de subir a carga.',
};

export const LOAD_STATUS_LABELS: Record<LoadRunStatus, string> = {
  running: 'Rodando',
  ok: 'Sem erros',
  errors: 'Com erros',
  failed: 'Falhou',
  canceled: 'Cancelada',
  interrupted: 'Interrompida',
};

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  return value >= 1000 ? `${(value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} s` : `${Math.round(value)} ms`;
}

export function formatPct(value: number | null | undefined): string {
  return value === null || value === undefined ? '–' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

export function formatRps(value: number | null | undefined): string {
  return value === null || value === undefined ? '–' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}/s`;
}

export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function reportUrl(runId: string): string {
  return `/api/load-tests/${runId}/report/index.html`;
}
