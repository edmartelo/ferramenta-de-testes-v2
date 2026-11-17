<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { searchSonarIssues } from '../demo/sonar-browser';
import type { SonarIssue, SonarIssuePage, SonarIssueType, SonarSeverity } from '../lib/sonar-types';
import { formatEffort, SONAR_SEVERITY_LABELS, SONAR_SEVERITY_ORIGINAL, SONAR_TYPE_HINTS, SONAR_TYPE_LABELS } from '../lib/sonar-labels';

const props = defineProps<{ projectKey: string; newCode: boolean; refreshKey: string; issuesUrl: string }>();
const type = defineModel<SonarIssueType | ''>('type', { required: true });

const TYPES = Object.keys(SONAR_TYPE_LABELS) as SonarIssueType[];
const SEVERITIES = Object.keys(SONAR_SEVERITY_LABELS) as SonarSeverity[];

const severity = ref<SonarSeverity | ''>('');
const file = ref('');
const issues = ref<SonarIssue[]>([]);
const page = ref<SonarIssuePage>();
const fileOptions = ref<{ path: string; count: number }[]>([]);
const loading = ref(false);
const error = ref('');
let requestId = 0;

const hasFilters = computed(() => Boolean(type.value || severity.value || file.value));
const hasMore = computed(() => Boolean(page.value && issues.value.length < Math.min(page.value.total, 10_000)));
const idPrefix = 'sonar-issues';

async function load(nextPage = 1): Promise<void> {
  const current = ++requestId;
  loading.value = true;
  error.value = '';
  try {
    const result = await searchSonarIssues(props.projectKey, {
      type: type.value || undefined,
      severity: severity.value || undefined,
      file: file.value || undefined,
      newCode: props.newCode,
      page: nextPage,
    });
    if (current !== requestId) return;
    page.value = result;
    issues.value = nextPage === 1 ? result.issues : [...issues.value, ...result.issues];
    // Com um arquivo escolhido, a contagem por arquivo só traz ele: mantém a lista anterior no seletor.
    if (!file.value) fileOptions.value = result.files;
  } catch (e) {
    if (current === requestId) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (current === requestId) loading.value = false;
  }
}

function clearFilters(): void {
  type.value = '';
  severity.value = '';
  file.value = '';
}

function countLabel(count: number | undefined): string {
  return count === undefined ? '' : ` (${count})`;
}

watch([type, severity, file, () => props.newCode, () => props.refreshKey, () => props.projectKey], () => load(1), { immediate: true });
</script>

<template>
  <section class="card sonar-issues" :aria-labelledby="`${idPrefix}-issues-title`">
    <div class="sonar-issues-header">
      <h3 :id="`${idPrefix}-issues-title`">Problemas{{ page ? ` (${page.total})` : '' }}</h3>
      <a :href="issuesUrl" target="_blank" rel="noopener noreferrer" class="sonar-external">Ver todos no SonarQube <span aria-hidden="true">↗</span></a>
    </div>

    <div class="sonar-filters">
      <div class="sonar-filter">
        <label :for="`${idPrefix}-type`">Tipo</label>
        <select :id="`${idPrefix}-type`" v-model="type">
          <option value="">Todos</option>
          <option v-for="item in TYPES" :key="item" :value="item">{{ SONAR_TYPE_LABELS[item] }}{{ countLabel(page?.types[item]) }}</option>
        </select>
      </div>
      <div class="sonar-filter">
        <label :for="`${idPrefix}-severity`">Severidade</label>
        <select :id="`${idPrefix}-severity`" v-model="severity">
          <option value="">Todas</option>
          <option v-for="item in SEVERITIES" :key="item" :value="item">{{ SONAR_SEVERITY_LABELS[item] }}{{ countLabel(page?.severities[item]) }}</option>
        </select>
      </div>
      <div class="sonar-filter sonar-filter-file">
        <label :for="`${idPrefix}-file`">Arquivo</label>
        <select :id="`${idPrefix}-file`" v-model="file">
          <option value="">Todos</option>
          <option v-for="item in fileOptions" :key="item.path" :value="item.path">{{ item.path }} ({{ item.count }})</option>
        </select>
      </div>
      <button v-if="hasFilters" type="button" class="ghost sonar-clear" @click="clearFilters">Limpar filtros</button>
    </div>

    <p v-if="error" role="alert" class="sonar-error">{{ error }}</p>
    <p v-else-if="loading && !issues.length" role="status" class="progress-caption">Carregando problemas...</p>
    <p v-else-if="!issues.length" class="progress-caption">
      {{ hasFilters ? 'Nenhum problema com esses filtros.' : newCode ? 'Nenhum problema no código novo.' : 'Nenhum problema aberto.' }}
    </p>

    <ul v-if="issues.length" class="sonar-issue-list">
      <li v-for="issue in issues" :key="issue.key" class="sonar-issue">
        <div class="sonar-issue-meta">
          <span
            v-if="issue.severity"
            class="sonar-severity"
            :class="`sonar-severity-${issue.severity.toLowerCase()}`"
            :title="`Severidade: ${SONAR_SEVERITY_LABELS[issue.severity]} (${SONAR_SEVERITY_ORIGINAL[issue.severity]})`"
          >{{ SONAR_SEVERITY_LABELS[issue.severity] }}</span>
          <span v-if="issue.type" class="sonar-type" :title="SONAR_TYPE_HINTS[issue.type]">{{ SONAR_TYPE_LABELS[issue.type] }}</span>
          <span v-if="issue.file" class="sonar-file">{{ issue.file }}{{ issue.line ? `:${issue.line}` : '' }}</span>
          <span v-if="issue.effort" class="sonar-effort" title="Esforço estimado para corrigir">{{ formatEffort(issue.effort) }}</span>
        </div>
        <p class="sonar-message" lang="en">{{ issue.message }}</p>
        <div class="sonar-issue-footer">
          <small class="field-hint">Regra {{ issue.rule }}<template v-if="issue.ruleName"> · <span lang="en">{{ issue.ruleName }}</span></template></small>
          <a :href="issue.url" target="_blank" rel="noopener noreferrer" class="sonar-external" :aria-label="`Abrir no SonarQube o problema em ${issue.file ?? 'arquivo'}${issue.line ? ` linha ${issue.line}` : ''}`">
            Abrir no SonarQube <span aria-hidden="true">↗</span>
          </a>
        </div>
      </li>
    </ul>

    <div v-if="hasMore" class="run-group-buttons">
      <button type="button" class="ghost" :disabled="loading" @click="load((page?.page ?? 1) + 1)">
        {{ loading ? 'Carregando...' : `Carregar mais (${issues.length} de ${page?.total})` }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.sonar-issues-header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.sonar-issues-header h3 {
  margin: 0;
}

.sonar-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 16px;
}

.sonar-filter {
  flex: 1 1 160px;
  min-width: 0;
}

.sonar-filter-file {
  flex: 2 1 240px;
}

.sonar-filter label {
  margin-bottom: 4px;
}

.sonar-issue-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sonar-issue {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  min-width: 0;
}

.sonar-issue-meta,
.sonar-issue-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}

.sonar-issue-footer {
  justify-content: space-between;
}

.sonar-message {
  margin: 8px 0;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.sonar-severity,
.sonar-type {
  font-size: 12px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
}

.sonar-severity-blocker,
.sonar-severity-critical {
  color: var(--danger);
  background: var(--danger-soft);
}

.sonar-severity-major {
  color: var(--accent-orange);
  background: var(--accent-orange-soft);
}

.sonar-severity-minor {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.sonar-severity-info {
  color: var(--accent-blue);
  background: var(--accent-blue-soft);
}

.sonar-type {
  color: var(--text-secondary);
  font-weight: 600;
}

.sonar-file {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.sonar-effort {
  font-size: 12px;
  color: var(--text-secondary);
}

.sonar-error {
  color: var(--danger);
}

.sonar-external {
  color: var(--accent-orange);
  font-size: 13px;
  white-space: nowrap;
}
</style>
