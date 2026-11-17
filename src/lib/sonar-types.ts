export type SonarRating = 'A' | 'B' | 'C' | 'D' | 'E';

export interface SonarMeasures {
  security: number | null;
  securityRating: SonarRating | null;
  reliability: number | null;
  reliabilityRating: SonarRating | null;
  maintainability: number | null;
  maintainabilityRating: SonarRating | null;
  vulnerabilities: number | null;
  bugs: number | null;
  codeSmells: number | null;
  securityHotspots: number | null;
  securityHotspotsReviewed: number | null;
  securityReviewRating: SonarRating | null;
  coverage: number | null;
  duplications: number | null;
  lines: number | null;
  acceptedIssues: number | null;
}

export interface SonarProjectSummary {
  key: string;
  name: string;
  qualityGate: 'OK' | 'ERROR' | null;
  analyzedAt: string | null;
  measures: SonarMeasures;
}

export interface SonarGateCondition {
  metric: string;
  comparator: string;
  threshold: string | null;
  actual: string | null;
  passed: boolean;
}

export interface SonarDetails {
  projectKey: string;
  name: string;
  qualityGate: 'OK' | 'ERROR' | null;
  conditions: SonarGateCondition[];
  overall: SonarMeasures;
  newCode: SonarMeasures | null;
  newCodeSince: string | null;
  analyzedAt: string | null;
  url: string;
  issuesUrl: string;
}

export const SONAR_ISSUE_TYPES = ['BUG', 'VULNERABILITY', 'CODE_SMELL'] as const;
export type SonarIssueType = (typeof SONAR_ISSUE_TYPES)[number];
export const SONAR_SEVERITIES = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'] as const;
export type SonarSeverity = (typeof SONAR_SEVERITIES)[number];

export interface SonarIssueFilters {
  type?: SonarIssueType;
  severity?: SonarSeverity;
  file?: string;
  newCode?: boolean;
  page?: number;
}

export interface SonarIssue {
  key: string;
  rule: string;
  ruleName: string | null;
  type: SonarIssueType | null;
  severity: SonarSeverity | null;
  file: string | null;
  line: number | null;
  message: string;
  effort: string | null;
  url: string;
}

export interface SonarIssuePage {
  total: number;
  page: number;
  pageSize: number;
  issues: SonarIssue[];
  types: Partial<Record<SonarIssueType, number>>;
  severities: Partial<Record<SonarSeverity, number>>;
  files: { path: string; count: number }[];
}
