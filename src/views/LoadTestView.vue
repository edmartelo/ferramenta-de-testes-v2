<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, type LoadOverviewPromotion } from '../api';
import { errorMessage } from '../composables/utils';
import { formatDateTime, formatMs, formatPct, LOAD_ENV_LABELS, LOAD_STATUS_LABELS } from '../lib/load-test-labels';

const POLL_MS = 5_000;

const promotions = ref<LoadOverviewPromotion[]>();
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;

const running = computed(() => promotions.value?.some((promotion) => promotion.last?.status === 'running') ?? false);

async function load(): Promise<void> {
  clearTimeout(timer);
  try {
    promotions.value = await api.getLoadTestsOverview();
    error.value = '';
  } catch (e) {
    error.value = errorMessage(e);
  }
  if (running.value) timer = setTimeout(load, POLL_MS);
}

onMounted(load);
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div class="load-list-view">
    <header class="page-header">
      <span class="eyebrow">Testes</span>
      <h1>JMeter</h1>
      <p>Teste de carga das promoções em teste, rodado pelo JMeter no Docker desta máquina. Só Dev e Homolog: Produção é bloqueada pelo servidor.</p>
    </header>

    <p v-if="error" role="alert" class="error-text">{{ error }}</p>
    <p v-else-if="!promotions" role="status" class="progress-caption">Carregando promoções...</p>
    <p v-else-if="!promotions.length" class="progress-caption">Nenhuma promoção em teste.</p>

    <ul v-if="promotions?.length" class="load-list">
      <li v-for="promotion in promotions" :key="promotion.id">
        <router-link :to="`/carga/${promotion.id}`" class="card load-row">
          <span class="load-row-name">
            <strong>{{ promotion.name }}</strong>
            <span>{{ promotion.client }}</span>
          </span>
          <span v-if="!promotion.last" class="load-row-state">Ainda sem teste de carga</span>
          <span v-else class="load-row-state">
            <span :class="`load-status load-status-${promotion.last.status}`">{{ LOAD_STATUS_LABELS[promotion.last.status] }}</span>
            <span>{{ LOAD_ENV_LABELS[promotion.last.env] }} · {{ promotion.last.users }} usuários · {{ formatDateTime(promotion.last.startedAt) }}</span>
            <span v-if="promotion.last.summary?.total">
              p95 {{ formatMs(promotion.last.summary.total.p95Ms) }} · erro {{ formatPct(promotion.last.summary.total.errorPct) }}
            </span>
          </span>
        </router-link>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.load-list-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1200px;
}

.load-list-view .page-header {
  margin-bottom: 0;
}

.load-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.load-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(0, 2fr);
  gap: 8px 20px;
  align-items: center;
  padding: 16px;
  text-decoration: none;
  color: var(--text-primary);
}

.load-row:hover {
  background: var(--surface-hover);
}

.load-row-name {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.load-row-name strong {
  font-size: 15px;
}

.load-row-name span,
.load-row-state {
  color: var(--text-secondary);
  font-size: 13px;
}

.load-row-state {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.load-status {
  font-weight: 700;
}

.load-status-ok {
  color: var(--accent-green);
}

.load-status-errors,
.load-status-failed,
.load-status-interrupted {
  color: var(--danger);
}

.load-status-running {
  color: var(--accent);
}

@media (max-width: 720px) {
  .load-row {
    grid-template-columns: 1fr;
  }
}
</style>
