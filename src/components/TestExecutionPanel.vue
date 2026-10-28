<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TestResultRow, TestRunState } from '../composables/useTestRun';

type Status = TestResultRow['status'];

function statusLabel(status: Status): string {
  if (status === 'ok') return '✓ OK';
  if (status === 'failed') return '✗ Falhou';
  return '– N/A';
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

const props = defineProps<{ run: TestRunState }>();

const elapsed = computed(() => formatDuration(props.run.elapsedMs));

const statusFilter = ref<Status | undefined>(undefined);

watch(() => props.run.running, (running) => {
  if (running) statusFilter.value = undefined;
});

function toggleFilter(status: Status): void {
  statusFilter.value = statusFilter.value === status ? undefined : status;
}

const visibleResults = computed(() =>
  props.run.testResults.filter((item) => !statusFilter.value || item.status === statusFilter.value).slice().reverse(),
);

const summary = computed<{ status: Status; count: number; label: string }[]>(() => [
  { status: 'ok', count: props.run.okCount, label: 'OK' },
  { status: 'failed', count: props.run.failedCount, label: 'Falhou' },
  { status: 'not-applicable', count: props.run.naCount, label: 'N/A' },
]);
</script>

<template>
  <aside class="test-progress-panel env-column">
    <div class="test-progress-panel-header">
      <h3>Execução de testes</h3>

      <div
        v-if="run.progressTotal"
        class="progress-bar-track"
        role="progressbar"
        aria-label="Progresso da rodada"
        aria-valuemin="0"
        :aria-valuemax="run.progressTotal"
        :aria-valuenow="run.progressDone"
      >
        <div class="progress-bar-fill" :style="{ width: `${run.progressPercent}%` }"></div>
      </div>
      <p v-if="run.progressTotal || run.running" class="progress-caption run-meta">
        <span>{{ run.progressTotal ? `${run.progressDone} / ${run.progressTotal} testes` : 'Iniciando...' }}</span>
        <span v-if="run.running" class="run-elapsed" title="Tempo decorrido">⏱ {{ elapsed }}</span>
      </p>

      <p v-if="run.running" class="current-test" :class="{ 'current-test-idle': !run.currentTest && !run.status }" aria-live="polite">
        {{ run.currentTest ? `▶ ${run.currentTest.title}` : run.status ? `⚙ ${run.status}` : '▶  ' }}
      </p>
      <p v-if="!run.running && run.testResults.length" class="run-summary">
        <button
          v-for="item in summary"
          :key="item.status"
          type="button"
          class="test-status summary-filter"
          :class="[item.status, { active: statusFilter === item.status }]"
          :disabled="!item.count"
          :title="statusFilter === item.status ? 'Mostrar todos' : `Mostrar só: ${item.label}`"
          @click="toggleFilter(item.status)"
        >
          {{ item.count }} {{ item.label }}
        </button>
        <button v-if="statusFilter" type="button" class="summary-clear" @click="statusFilter = undefined">
          Mostrar todos
        </button>
        <span v-if="run.elapsedMs" class="run-elapsed run-elapsed-total" title="Tempo total da rodada">⏱ {{ elapsed }}</span>
      </p>
      <p v-if="run.runError" role="alert" style="color: var(--danger)">{{ run.runError }}</p>
    </div>

    <TransitionGroup v-if="visibleResults.length" name="test-item" tag="ul" class="test-list themed-scrollbar">
      <li v-for="item in visibleResults" :key="item.itemId">
        <span>
          {{ item.title }}
          <small v-if="item.detail" class="test-detail" :class="item.status">{{ item.detail }}</small>
        </span>
        <span class="test-status" :class="item.status">{{ statusLabel(item.status) }}</span>
      </li>
    </TransitionGroup>
    <p v-else-if="!run.running && !run.progressTotal" class="progress-caption">
      Nenhum teste rodado ainda nesta sessão.
    </p>
  </aside>
</template>
