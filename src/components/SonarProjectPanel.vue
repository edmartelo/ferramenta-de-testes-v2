<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { readSonarDetails } from '../demo/sonar-browser';
import { formatDecimal, formatSonarDate, gateConditionText } from '../lib/sonar-labels';
import type { SonarDetails, SonarIssueType, SonarMeasures } from '../lib/sonar-types';
import SonarIssuesList from './SonarIssuesList.vue';
import SonarRating from './SonarRating.vue';
import SonarScanCommand from './SonarScanCommand.vue';

const props = defineProps<{ projectKey: string }>();

const details = ref<SonarDetails | null>(null);
const loading = ref(false);
const loaded = ref(false);
const error = ref('');
const scope = ref<'overall' | 'newCode'>('overall');
const typeFilter = ref<SonarIssueType | ''>('');

const measures = computed<SonarMeasures | null>(() => (scope.value === 'newCode' ? details.value?.newCode : details.value?.overall) ?? null);
const newCodeSince = computed(() => (details.value?.newCodeSince ? new Date(details.value.newCodeSince).toLocaleDateString('pt-BR') : ''));
const gateOnlyNewCode = computed(() => Boolean(details.value?.conditions.length) && details.value!.conditions.every((condition) => condition.metric.startsWith('new_')));
const emptyNewCode = computed(() => !details.value?.newCode || !details.value.newCode.lines);

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    details.value = (await readSonarDetails(props.projectKey)) ?? null;
    if (!details.value?.newCode) scope.value = 'overall';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
    loaded.value = true;
  }
}

function count(value: number | null): string {
  return value === null ? '–' : value.toLocaleString('pt-BR');
}

function percent(value: number | null): string {
  return value === null ? '–' : `${formatDecimal(value)}%`;
}

function filterBy(type: SonarIssueType): void {
  typeFilter.value = typeFilter.value === type ? '' : type;
}

const QUALITY_CARDS = [
  { key: 'security', rating: 'securityRating', legacy: 'vulnerabilities', type: 'VULNERABILITY', title: 'Segurança', legacyLabel: 'Vulnerabilidades' },
  { key: 'reliability', rating: 'reliabilityRating', legacy: 'bugs', type: 'BUG', title: 'Confiabilidade', legacyLabel: 'Bugs' },
  { key: 'maintainability', rating: 'maintainabilityRating', legacy: 'codeSmells', type: 'CODE_SMELL', title: 'Manutenibilidade', legacyLabel: 'Code smells' },
] as const;

watch(() => props.projectKey, load, { immediate: true });
</script>

<template>
  <div class="sonar-panel">
    <section class="card sonar-panel-header">
      <div class="sonar-panel-info">
        <h2>{{ details?.name ?? projectKey }}</h2>
        <p class="sonar-key">Chave: <code>{{ projectKey }}</code></p>
        <p v-if="details?.analyzedAt">Última análise em {{ formatSonarDate(details.analyzedAt) }}</p>
        <p v-else-if="loaded && !error && !details">Este projeto ainda não tem análise no SonarQube.</p>
      </div>
      <div class="sonar-panel-actions">
        <button type="button" class="primary" :disabled="loading" @click="load">{{ loading ? 'Atualizando...' : 'Atualizar' }}</button>
        <a v-if="details" :href="details.url" target="_blank" rel="noopener noreferrer" class="sonar-external">Abrir no SonarQube <span aria-hidden="true">↗</span></a>
      </div>
    </section>

    <details class="card sonar-command">
      <summary>Como rodar uma nova análise deste projeto</summary>
      <p>A análise roda na sua máquina, com Docker aberto. Troque o caminho de exemplo pela pasta do código.</p>
      <SonarScanCommand :project-key="projectKey" />
      <p class="field-hint">Quando o scanner terminar, clique em Atualizar.</p>
    </details>

    <p v-if="error" role="alert" class="sonar-error">{{ error }}</p>
    <p v-else-if="loading && !details" role="status" class="progress-caption">Carregando análise...</p>

    <template v-if="details">
      <section
        class="card sonar-gate"
        :class="details.qualityGate === 'ERROR' ? 'sonar-gate-failed' : details.qualityGate === 'OK' ? 'sonar-gate-passed' : ''"
        aria-label="Quality Gate"
      >
        <div class="sonar-gate-status">
          <span class="button-section-title" title="Critério de aprovação do SonarQube (Quality Gate)">Quality Gate</span>
          <strong v-if="details.qualityGate === 'OK'"><span aria-hidden="true">✓</span> Aprovado</strong>
          <strong v-else-if="details.qualityGate === 'ERROR'"><span aria-hidden="true">✗</span> Reprovado</strong>
          <strong v-else>Sem resultado</strong>
        </div>
        <ul v-if="details.conditions.length" class="sonar-conditions">
          <li v-for="condition in details.conditions" :key="condition.metric">
            <span aria-hidden="true">{{ condition.passed ? '✓' : '✗' }}</span>
            <span class="visually-hidden">{{ condition.passed ? 'Passou:' : 'Falhou:' }}</span>
            {{ gateConditionText(condition) }}
          </li>
        </ul>
        <p v-if="gateOnlyNewCode" class="field-hint">
          Como no padrão do SonarQube (Sonar way), o Quality Gate avalia só o código novo{{ newCodeSince ? ` (desde ${newCodeSince})` : '' }}. Problemas no código geral não reprovam.
        </p>
      </section>

      <nav class="sonar-tabs" aria-label="Escopo da análise">
        <button type="button" class="sonar-tab" :class="{ active: scope === 'overall' }" :aria-pressed="scope === 'overall'" @click="scope = 'overall'">
          Código geral
        </button>
        <button
          type="button"
          class="sonar-tab"
          :class="{ active: scope === 'newCode' }"
          :aria-pressed="scope === 'newCode'"
          :disabled="!details.newCode"
          :title="!details.newCode ? 'O SonarQube não tem período de código novo para este projeto.' : undefined"
          @click="scope = 'newCode'"
        >
          Código novo{{ newCodeSince ? ` (desde ${newCodeSince})` : '' }}
        </button>
      </nav>

      <p v-if="scope === 'newCode' && emptyNewCode" class="progress-caption">
        Nenhuma linha alterada{{ newCodeSince ? ` desde ${newCodeSince}` : '' }}. O código novo depende da definição do projeto no SonarQube
        (Project Settings → New Code); para projeto sem versão de release, o SonarQube recomenda "número de dias".
      </p>

      <div v-if="measures" class="sonar-measures">
        <button
          v-for="card in QUALITY_CARDS"
          :key="card.key"
          type="button"
          class="sonar-measure sonar-measure-button"
          :class="{ selected: typeFilter === card.type }"
          :aria-pressed="typeFilter === card.type"
          :title="`Mostrar só ${card.legacyLabel.toLowerCase()} na lista de problemas. Um problema pode afetar mais de uma qualidade, então este total pode diferir da contagem de ${card.legacyLabel.toLowerCase()}.`"
          @click="filterBy(card.type)"
        >
          <span class="sonar-measure-title">{{ card.title }}</span>
          <span class="sonar-measure-value">
            <strong>{{ count(measures[card.key]) }}</strong>
            <SonarRating :rating="measures[card.rating]" :label="card.title" />
          </span>
          <small class="field-hint">({{ card.legacyLabel }}: {{ count(measures[card.legacy]) }})</small>
        </button>

        <div class="sonar-measure">
          <span class="sonar-measure-title" title="Trechos sensíveis que alguém precisa revisar (Security Hotspots)">Pontos de segurança</span>
          <span class="sonar-measure-value">
            <strong>{{ count(measures.securityHotspots) }}</strong>
            <SonarRating :rating="measures.securityReviewRating" label="Revisão de segurança" />
          </span>
          <small class="field-hint">{{ measures.securityHotspotsReviewed === null ? 'Nada a revisar' : `${percent(measures.securityHotspotsReviewed)} revisados` }}</small>
        </div>

        <div class="sonar-measure">
          <span class="sonar-measure-title">Cobertura</span>
          <span class="sonar-measure-value"><strong>{{ percent(measures.coverage) }}</strong></span>
          <small v-if="!measures.coverage" class="field-hint">A análise não importa relatório de testes.</small>
        </div>

        <div class="sonar-measure">
          <span class="sonar-measure-title">Duplicações</span>
          <span class="sonar-measure-value"><strong>{{ percent(measures.duplications) }}</strong></span>
          <small class="field-hint">{{ count(measures.lines) }} {{ scope === 'newCode' ? 'linhas novas' : 'linhas de código' }}</small>
        </div>

        <div class="sonar-measure">
          <span class="sonar-measure-title" title="Problemas marcados como aceitos no SonarQube (Accepted issues)">Problemas aceitos</span>
          <span class="sonar-measure-value"><strong>{{ count(measures.acceptedIssues) }}</strong></span>
        </div>
      </div>
      <p class="field-hint sonar-legend">
        Os cartões seguem o SonarQube: Segurança, Confiabilidade e Manutenibilidade. Um problema pode contar em mais de uma, por isso os totais podem diferir dos tipos usados no filtro (Vulnerabilidade, Bug e Code smell). Clique num cartão para filtrar a lista.
      </p>

      <SonarIssuesList
        v-model:type="typeFilter"
        :project-key="projectKey"
        :new-code="scope === 'newCode'"
        :refresh-key="details.analyzedAt ?? ''"
        :issues-url="details.issuesUrl"
      />
    </template>
  </div>
</template>

<style scoped>
.sonar-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.sonar-panel-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px 20px;
}

.sonar-panel-info {
  flex: 1 1 280px;
  min-width: 0;
}

.sonar-panel-info h2 {
  font-size: 18px;
  overflow-wrap: anywhere;
}

.sonar-panel-info p {
  margin: 4px 0;
}

.sonar-key code {
  overflow-wrap: anywhere;
}

.sonar-panel-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.sonar-command summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--text-primary);
}

.sonar-error {
  color: var(--danger);
  margin: 0;
}

.sonar-gate {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 24px;
}

.sonar-gate-passed {
  border-left-color: var(--accent-green);
}

.sonar-gate-passed .sonar-gate-status strong {
  color: var(--accent-green);
}

.sonar-gate-failed {
  border-left-color: var(--danger);
}

.sonar-gate-failed .sonar-gate-status strong {
  color: var(--danger);
}

.sonar-gate-status {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sonar-gate-status strong {
  font-size: 20px;
}

.sonar-gate .field-hint {
  flex-basis: 100%;
  margin: 0;
}

.sonar-conditions {
  list-style: none;
  margin: 0;
  padding: 0;
  color: var(--text-secondary);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sonar-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}

.sonar-tab {
  padding: 10px 16px;
  background: transparent;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--text-secondary);
  white-space: nowrap;
}

.sonar-tab:hover:not(:disabled) {
  color: var(--text-primary);
}

.sonar-tab.active {
  color: var(--accent-orange);
  border-bottom-color: var(--accent-orange);
}

.sonar-tab:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sonar-measures {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 12px;
}

.sonar-measure {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  text-align: left;
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.sonar-measure-button {
  font-weight: 400;
  color: var(--text-primary);
}

.sonar-measure-button:hover {
  background: var(--surface-hover);
}

.sonar-measure-button.selected {
  border-color: var(--accent-orange);
  background: var(--accent-orange-soft);
}

.sonar-measure-title {
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
}

.sonar-measure-value {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sonar-measure-value strong {
  font-size: 24px;
}

.sonar-legend {
  margin: -4px 0 0;
}

.sonar-external {
  color: var(--accent-orange);
  font-size: 13px;
  white-space: nowrap;
}

:is(.sonar-tab, .sonar-measure-button, .sonar-command summary):focus-visible {
  outline: 2px solid var(--accent-orange);
  outline-offset: 2px;
}

@media (max-width: 600px) {
  .sonar-panel-actions {
    align-items: stretch;
    width: 100%;
  }
}
</style>
