<script setup lang="ts">
import { onMounted, ref } from 'vue';
import SonarFirstAnalysis from '../components/SonarFirstAnalysis.vue';
import SonarRating from '../components/SonarRating.vue';
import SonarSetupWizard from '../components/SonarSetupWizard.vue';
import { disconnectSonar, listSonarProjects, restoreSonarConnection, sonarConnection } from '../demo/sonar-browser';
import { formatDecimal, formatSonarDate } from '../lib/sonar-labels';
import type { SonarProjectSummary } from '../lib/sonar-types';

const restoring = ref(false);
const showHowTo = ref(false);
const connectError = ref('');

const projects = ref<SonarProjectSummary[]>([]);
const total = ref(0);
const loadingProjects = ref(false);
const loadedProjects = ref(false);
const projectsError = ref('');

const QUALITIES = [
  { count: 'security', rating: 'securityRating', label: 'Segurança' },
  { count: 'reliability', rating: 'reliabilityRating', label: 'Confiabilidade' },
  { count: 'maintainability', rating: 'maintainabilityRating', label: 'Manutenibilidade' },
] as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadProjects(): Promise<void> {
  if (loadingProjects.value) return;
  loadingProjects.value = true;
  projectsError.value = '';
  try {
    const result = await listSonarProjects();
    projects.value = result.projects;
    total.value = result.total;
  } catch (error) {
    projectsError.value = message(error);
  } finally {
    loadingProjects.value = false;
    loadedProjects.value = true;
  }
}

function disconnect(): void {
  disconnectSonar();
  projects.value = [];
  total.value = 0;
  loadedProjects.value = false;
}

function percent(value: number | null): string {
  return value === null ? '–' : `${formatDecimal(value)}%`;
}

function count(value: number | null): string {
  return value === null ? '–' : value.toLocaleString('pt-BR');
}

function compactLines(value: number | null): string {
  return value === null ? '–' : value.toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
}

onMounted(async () => {
  restoring.value = true;
  try {
    if (await restoreSonarConnection()) await loadProjects();
  } catch (error) {
    connectError.value = message(error);
  } finally {
    restoring.value = false;
  }
});
</script>

<template>
  <div class="sonar-view">
    <header class="sonar-header">
      <div>
        <span class="eyebrow">Testes</span>
        <h1>Qualidade de código</h1>
        <p>Os projetos do seu SonarQube local, no formato do painel do SonarQube: Quality Gate, notas de A a E e a lista de problemas.</p>
      </div>
      <div v-if="sonarConnection.connected" class="sonar-header-actions">
        <button type="button" class="primary" :disabled="loadingProjects" @click="loadProjects">{{ loadingProjects ? 'Atualizando...' : 'Atualizar' }}</button>
        <button type="button" class="ghost" @click="disconnect">Desconectar</button>
      </div>
    </header>

    <p v-if="restoring" role="status" class="progress-caption">Conectando ao SonarQube...</p>

    <template v-else-if="!sonarConnection.connected">
      <p v-if="connectError" role="alert" class="sonar-error">{{ connectError }}</p>
      <SonarSetupWizard @connected="loadProjects" />
    </template>

    <template v-else>
      <p class="field-hint sonar-connected">
        Conectado ao SonarQube em {{ sonarConnection.sonarUrl }} pelo proxy {{ sonarConnection.proxyUrl }}.
      </p>
      <p v-if="projectsError" role="alert" class="sonar-error">{{ projectsError }}</p>
      <p v-else-if="loadingProjects && !projects.length" role="status" class="progress-caption">Carregando projetos...</p>

      <section v-else-if="loadedProjects && !projects.length" class="card sonar-how-to" aria-labelledby="sonar-first-title">
        <h2 id="sonar-first-title">Primeira análise</h2>
        <p>Conectado. Seu SonarQube ainda não tem projetos: rode a primeira análise.</p>
        <SonarFirstAnalysis id-prefix="first-analysis" />
      </section>

      <div v-if="projects.length" class="sonar-how-to-toggle">
        <button type="button" class="sonar-link-button" :aria-expanded="showHowTo" aria-controls="sonar-how-to" @click="showHowTo = !showHowTo">
          {{ showHowTo ? 'Fechar instruções de análise' : 'Como analisar um projeto' }}
        </button>
      </div>
      <section v-if="projects.length && showHowTo" id="sonar-how-to" class="card sonar-how-to" aria-labelledby="sonar-how-to-title">
        <h2 id="sonar-how-to-title">Como analisar um projeto</h2>
        <SonarFirstAnalysis id-prefix="how-to-analysis" />
      </section>

      <p v-if="total > projects.length" class="field-hint">Mostrando {{ projects.length }} de {{ total }} projetos.</p>

      <ul v-if="projects.length" class="sonar-list">
        <li v-for="project in projects" :key="project.key" class="card sonar-row">
          <div class="sonar-row-top">
            <router-link :to="{ name: 'qualidade-codigo-projeto', params: { projectKey: project.key } }" class="sonar-row-name">{{ project.name }}</router-link>
            <span v-if="project.qualityGate === 'OK'" class="sonar-gate sonar-gate-ok"><span aria-hidden="true">✓</span> Aprovado</span>
            <span v-else-if="project.qualityGate === 'ERROR'" class="sonar-gate sonar-gate-error"><span aria-hidden="true">✗</span> Reprovado</span>
            <span v-else class="sonar-gate">Sem Quality Gate</span>
          </div>
          <p class="field-hint sonar-row-date">
            {{ project.analyzedAt ? `Última análise em ${formatSonarDate(project.analyzedAt)}` : 'Ainda sem análise' }}
          </p>
          <dl class="sonar-metrics">
            <div v-for="quality in QUALITIES" :key="quality.rating">
              <dt>{{ quality.label }}</dt>
              <dd>
                {{ count(project.measures[quality.count]) }}
                <SonarRating :rating="project.measures[quality.rating]" :label="quality.label" small />
              </dd>
            </div>
            <div>
              <dt title="Security Hotspots">Pontos de segurança</dt>
              <dd><SonarRating :rating="project.measures.securityReviewRating" label="Pontos de segurança" small /></dd>
            </div>
            <div>
              <dt>Cobertura</dt>
              <dd>{{ percent(project.measures.coverage) }}</dd>
            </div>
            <div>
              <dt>Duplicações</dt>
              <dd>{{ percent(project.measures.duplications) }}</dd>
            </div>
            <div>
              <dt>Linhas</dt>
              <dd>{{ compactLines(project.measures.lines) }}</dd>
            </div>
          </dl>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.sonar-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1200px;
}

.sonar-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px 24px;
}

.sonar-header > div:first-child {
  flex: 1 1 360px;
}

.sonar-header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.sonar-error {
  color: var(--danger);
}

.sonar-connected {
  margin: 0;
}

.sonar-how-to {
  max-width: 820px;
}

.sonar-how-to h2 {
  font-size: 1.1rem;
}

.sonar-link-button {
  padding: 0;
  background: transparent;
  color: var(--accent-orange);
  text-decoration: underline;
  font-weight: 600;
}

.sonar-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sonar-row {
  padding: 16px;
}

.sonar-row-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
}

.sonar-row-name {
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.sonar-row-name:hover {
  color: var(--accent-orange);
}

.sonar-row-date {
  margin: 4px 0 12px;
}

.sonar-gate {
  font-weight: 700;
  font-size: 13px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-secondary);
}

.sonar-gate-ok {
  color: var(--accent-green);
  border-color: var(--accent-green);
  background: var(--accent-green-soft);
}

.sonar-gate-error {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--danger-soft);
}

.sonar-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
  margin: 0;
}

.sonar-metrics div {
  display: flex;
  flex-direction: column-reverse;
  gap: 2px;
  min-width: 0;
}

.sonar-metrics dt {
  color: var(--text-secondary);
  font-size: 12px;
}

.sonar-metrics dd {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  font-weight: 700;
  color: var(--text-primary);
}

:is(.sonar-row-name, .sonar-link-button):focus-visible {
  outline: 2px solid var(--accent-orange);
  outline-offset: 2px;
}
</style>
