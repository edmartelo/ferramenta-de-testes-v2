import type { SonarGateCondition, SonarIssueType, SonarSeverity } from './sonar-types.ts';

export const SONAR_TYPE_LABELS: Record<SonarIssueType, string> = {
  BUG: 'Bug',
  VULNERABILITY: 'Vulnerabilidade',
  CODE_SMELL: 'Code smell',
};

export const SONAR_TYPE_HINTS: Record<SonarIssueType, string> = {
  BUG: 'Erro que pode fazer o sistema se comportar de forma errada.',
  VULNERABILITY: 'Falha que pode ser explorada por um atacante.',
  CODE_SMELL: 'Código difícil de manter (Code smell).',
};

export const SONAR_SEVERITY_LABELS: Record<SonarSeverity, string> = {
  BLOCKER: 'Bloqueador',
  CRITICAL: 'Crítico',
  MAJOR: 'Alto',
  MINOR: 'Baixo',
  INFO: 'Informativo',
};

export const SONAR_SEVERITY_ORIGINAL: Record<SonarSeverity, string> = {
  BLOCKER: 'Blocker',
  CRITICAL: 'Critical',
  MAJOR: 'Major',
  MINOR: 'Minor',
  INFO: 'Info',
};

const GATE_METRIC_LABELS: Record<string, string> = {
  new_violations: 'Problemas novos',
  violations: 'Problemas',
  new_coverage: 'Cobertura do código novo',
  coverage: 'Cobertura',
  new_duplicated_lines_density: 'Duplicação no código novo',
  duplicated_lines_density: 'Duplicação',
  new_security_hotspots_reviewed: 'Pontos de segurança revisados no código novo',
  security_hotspots_reviewed: 'Pontos de segurança revisados',
  new_software_quality_security_rating: 'Nota de segurança do código novo',
  new_software_quality_reliability_rating: 'Nota de confiabilidade do código novo',
  new_software_quality_maintainability_rating: 'Nota de manutenibilidade do código novo',
  new_security_rating: 'Nota de segurança do código novo',
  new_reliability_rating: 'Nota de confiabilidade do código novo',
  new_maintainability_rating: 'Nota de manutenibilidade do código novo',
  software_quality_security_rating: 'Nota de segurança',
  software_quality_reliability_rating: 'Nota de confiabilidade',
  software_quality_maintainability_rating: 'Nota de manutenibilidade',
};

const COMPARATOR_LABELS: Record<string, string> = { GT: 'maior que', LT: 'menor que', EQ: 'igual a', NE: 'diferente de' };

const RATING_METRIC = /rating$/;
const PERCENT_METRIC = /coverage|density|reviewed$/;

function conditionValue(metric: string, value: string): string {
  if (RATING_METRIC.test(metric)) return ['A', 'B', 'C', 'D', 'E'][Math.round(Number(value)) - 1] ?? value;
  if (PERCENT_METRIC.test(metric)) return `${formatDecimal(Number(value))}%`;
  return value;
}

export function gateConditionText(condition: SonarGateCondition): string {
  const label = GATE_METRIC_LABELS[condition.metric] ?? condition.metric;
  const actual = condition.actual === null ? 'sem valor' : conditionValue(condition.metric, condition.actual);
  const comparator = COMPARATOR_LABELS[condition.comparator] ?? condition.comparator;
  const limit = condition.threshold === null ? '' : ` (reprova se ${comparator} ${conditionValue(condition.metric, condition.threshold)})`;
  return `${label}: ${actual}${limit}`;
}

export function formatDecimal(value: number): string {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

export function formatSonarDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
}

/** O Sonar devolve o esforço como `15min`, `1h30min` ou `2d`. */
export function formatEffort(effort: string | null): string {
  return effort ? effort.replace(/(\d+)d/, '$1 d ').replace(/(\d+)h/, '$1 h ').replace(/(\d+)min/, '$1 min').trim() : '';
}
