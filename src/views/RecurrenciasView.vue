<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import AtendimentosSummaryModal from '../components/AtendimentosSummaryModal.vue';
import ConfirmModal from '../components/ConfirmModal.vue';
import { siteRoute } from '../lib/site-url';
import PromotionPickerModal from '../components/PromotionPickerModal.vue';
import SlackSendModal from '../components/SlackSendModal.vue';
import TotpCodeModal from '../components/TotpCodeModal.vue';
import { hasAtendimentos } from '../../server/atendimentos-panels';
import { api, type Atendimento, type AtendimentosSummary, type RecurrencesPromotionResult } from '../api';
import { useTotpGate } from '../composables/useTotpGate';
import { errorMessage, safeHttpUrl } from '../composables/utils';

const isDemo = import.meta.env.MODE === 'demo';

const promotions = ref<RecurrencesPromotionResult[]>([]);
const loading = ref(false);
const error = ref('');
const scanned = ref(false);
const progressPercent = ref(0);
const currentStep = ref('');

const { totpModalOpen, requestTotp, confirmTotp, closeTotp } = useTotpGate();

interface AtendimentosState {
  loading: boolean;
  step: string;
  error: string;
  items: Atendimento[];
  /** `null` = todos; `''` é um status real (vazio). */
  statusFilter: string | null;
  search: string;
}
const atendimentos = reactive<Record<string, AtendimentosState>>({});
const expandedAtendimentos = ref<string | null>(null);

function toggleAtendimentos(promotionName: string) {
  expandedAtendimentos.value = expandedAtendimentos.value === promotionName ? null : promotionName;
}

function normalizeSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function visibleItems(state: AtendimentosState): Atendimento[] {
  const query = normalizeSearch(state.search.trim());
  return state.items.filter(
    (item) =>
      (state.statusFilter === null || item.status === state.statusFilter) &&
      (!query ||
        normalizeSearch([item.id, item.assunto, item.participante, item.dataRecebimento, item.status, item.mensagem].join(' ')).includes(query)),
  );
}
const atendimentosOrder = ref<string[]>([]);
const atendimentosControllers = new Map<string, AbortController>();
let scanController: AbortController | undefined;

const REFRESH_INTERVAL_SECONDS = 30;
const refreshCountdown = ref<number | null>(null);
const refreshing = ref(false);
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let refreshController: AbortController | undefined;

function stopAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = undefined;
  refreshController?.abort();
  refreshCountdown.value = null;
}

function startRefreshCountdown() {
  refreshCountdown.value = REFRESH_INTERVAL_SECONDS;
  refreshTimer = setInterval(() => {
    if (refreshCountdown.value === null) return;
    refreshCountdown.value -= 1;
    if (refreshCountdown.value > 0) return;
    clearInterval(refreshTimer);
    refreshCountdown.value = null;
    void refreshAccessCounts();
  }, 1000);
}

const schedule = ref<Awaited<ReturnType<typeof api.recurrencesSchedule>>>();
const savingSchedule = ref(false);

onMounted(async () => {
  try {
    schedule.value = await api.recurrencesSchedule();
  } catch (e) {
    error.value = errorMessage(e);
  }
});

async function toggleSchedule(event: Event) {
  const input = event.target as HTMLInputElement;
  savingSchedule.value = true;
  error.value = '';
  try {
    schedule.value = await api.setRecurrencesSchedule(input.checked);
  } catch (e) {
    input.checked = !input.checked;
    error.value = errorMessage(e);
  } finally {
    savingSchedule.value = false;
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const WHATSAPP_WINDOW_SECONDS = 20;
const whatsappCountdown = ref<number | null>(null);
const sendingWhatsApp = ref(false);
const whatsappSent = ref(false);
let whatsappTimer: ReturnType<typeof setInterval> | undefined;
let whatsappController: AbortController | undefined;

function stopWhatsAppCountdown() {
  clearInterval(whatsappTimer);
  whatsappTimer = undefined;
  whatsappCountdown.value = null;
}

function startWhatsAppCountdown() {
  whatsappSent.value = false;
  whatsappCountdown.value = WHATSAPP_WINDOW_SECONDS;
  whatsappTimer = setInterval(() => {
    if (whatsappCountdown.value === null) return;
    whatsappCountdown.value -= 1;
    if (whatsappCountdown.value <= 0) stopWhatsAppCountdown();
  }, 1000);
}

const slackText = ref<string | null>(null);
const loadingSlack = ref(false);

async function openSlack() {
  loadingSlack.value = true;
  error.value = '';
  try {
    slackText.value = await api.recurrencesMessage();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loadingSlack.value = false;
  }
}

const whatsappConfirmOpen = ref(false);

function confirmWhatsApp() {
  whatsappConfirmOpen.value = false;
  return sendWhatsApp();
}

async function sendWhatsApp() {
  stopWhatsAppCountdown();
  error.value = '';
  sendingWhatsApp.value = true;
  const controller = new AbortController();
  whatsappController = controller;
  try {
    await api.recurrencesWhatsApp(controller.signal);
    whatsappSent.value = true;
  } catch (e) {
    if (!controller.signal.aborted) error.value = errorMessage(e);
  } finally {
    sendingWhatsApp.value = false;
    whatsappController = undefined;
  }
}

function accessLevel(value: string): 'high' | 'medium' | 'low' {
  const count = Number(value.replace(/\D/g, ''));
  if (count >= 2000) return 'high';
  if (count >= 1000) return 'medium';
  return 'low';
}

async function refreshAccessCounts() {
  refreshing.value = true;
  const controller = new AbortController();
  refreshController = controller;
  try {
    const counts = new Map((await api.recurrencesRefresh(controller.signal)).map((count) => [count.name, count.analyticsCount]));
    for (const promo of promotions.value) {
      promo.analyticsCount = counts.get(promo.name) ?? promo.analyticsCount;
    }
    startRefreshCountdown();
  } catch (e) {
    if (!controller.signal.aborted) error.value = errorMessage(e);
  } finally {
    refreshing.value = false;
    if (refreshController === controller) refreshController = undefined;
  }
}

onBeforeUnmount(() => {
  scanController?.abort();
  stopAutoRefresh();
  stopWhatsAppCountdown();
  whatsappController?.abort();
  for (const controller of atendimentosControllers.values()) controller.abort();
  summaryController?.abort();
});

function panelUrlOf(promo: RecurrencesPromotionResult): string | undefined {
  return safeHttpUrl(promo.panelLinks.find((link) => link.label === 'Painel')?.url);
}

async function withPromoMonitorTotp(run: (totpCode: string | undefined) => Promise<void>, onError: (message: string) => void) {
  let hasTotpSecret: boolean;
  try {
    hasTotpSecret = (await api.connectorsStatus()).promoMonitorHasTotpSecret;
  } catch (e) {
    onError(errorMessage(e));
    return;
  }
  await requestTotp(hasTotpSecret, (code) => {
    closeTotp();
    return run(code);
  });
}

function scan() {
  error.value = '';
  return withPromoMonitorTotp(runScan, (message) => (error.value = message));
}

const promotionsWithPanel = computed(() => promotions.value.filter((promo) => hasAtendimentos(panelUrlOf(promo) ?? '')));
const atendimentosLoading = computed(() => atendimentosOrder.value.some((name) => atendimentos[name]?.loading));

async function scanAtendimentos(promotionName: string, panelUrl: string, totpCode: string | undefined) {
  // Consulta em produção: nunca duas no mesmo painel, e a anterior não pode ficar sem como parar.
  atendimentosControllers.get(promotionName)?.abort();
  atendimentos[promotionName] = { loading: true, step: '', error: '', items: [], statusFilter: null, search: '' };
  const state = atendimentos[promotionName]!;
  const controller = new AbortController();
  atendimentosControllers.set(promotionName, controller);
  try {
    const result = await api.atendimentosScan({ promotionName, panelUrl }, totpCode, (progress) => {
      state.step = progress.label;
      if (progress.atendimento) state.items.unshift(progress.atendimento);
    }, controller.signal);
    state.items = result.atendimentos;
  } catch (e) {
    state.error = controller.signal.aborted ? 'Consulta interrompida.' : errorMessage(e);
  } finally {
    state.loading = false;
    if (atendimentosControllers.get(promotionName) === controller) atendimentosControllers.delete(promotionName);
  }
}

function scanAllAtendimentos() {
  const targets = promotionsWithPanel.value.map((promo) => ({ name: promo.name, panelUrl: panelUrlOf(promo)! }));
  if (targets.length === 0) return;
  error.value = '';
  return withPromoMonitorTotp(
    async (totpCode) => {
      resetSummaries();
      atendimentosOrder.value = targets.map((target) => target.name);
      expandedAtendimentos.value = null;
      await Promise.all(targets.map((target) => scanAtendimentos(target.name, target.panelUrl, totpCode)));
    },
    (message) => (error.value = message),
  );
}

const summarizable = computed(() =>
  atendimentosOrder.value.filter((name) => atendimentos[name] && !atendimentos[name].loading && !atendimentos[name].error),
);
const summaryOpen = ref(false);
const summaries = ref<AtendimentosSummary[]>([]);
const summaryStep = ref('');
const summaryPercent = ref(0);
const summaryError = ref('');
let summaryController: AbortController | undefined;

function resetSummaries() {
  summaryController?.abort();
  summaryController = undefined;
  summaries.value = [];
  summaryStep.value = '';
  summaryError.value = '';
}

const atendimentosByPromotion = computed(() =>
  Object.fromEntries(atendimentosOrder.value.map((name) => [name, atendimentos[name]?.items ?? []])),
);

const panelUrlsByPromotion = computed(() =>
  Object.fromEntries(promotions.value.flatMap((promo) => {
    const url = panelUrlOf(promo);
    return url ? [[promo.name, siteRoute(url, 'atendimentos')]] : [];
  })),
);

const summaryPickerOpen = ref(false);
const summarySelection = ref<string[]>([]);
const selectedSummaries = computed(() =>
  summarySelection.value.flatMap((name) => summaries.value.filter((summary) => summary.promotionName === name)),
);

function openSummaryPicker() {
  if (summaryController) summaryOpen.value = true;
  else if (promotionsWithPanel.value.length === 0) error.value = 'Consulte as promoções primeiro para listar os painéis.';
  else summaryPickerOpen.value = true;
}

function summarizeAtendimentos(selected: string[]) {
  summaryPickerOpen.value = false;
  const targets = promotionsWithPanel.value
    .filter((promo) => selected.includes(promo.name))
    .map((promo) => ({ name: promo.name, panelUrl: panelUrlOf(promo)! }));
  if (targets.length === 0) return;
  error.value = '';
  return withPromoMonitorTotp(
    async (totpCode) => {
      resetSummaries();
      const controller = new AbortController();
      summaryController = controller;
      summarySelection.value = targets.map((target) => target.name);
      summaryOpen.value = true;
      atendimentosOrder.value = targets.map((target) => target.name);
      expandedAtendimentos.value = null;
      try {
        summaryStep.value = `Consultando atendimentos (${targets.length} promoç${targets.length === 1 ? 'ão' : 'ões'})`;
        summaryPercent.value = 0;
        await Promise.all(targets.map((target) => scanAtendimentos(target.name, target.panelUrl, totpCode)));
        if (controller.signal.aborted) return;
        const names = summarizable.value;
        for (const [index, name] of names.entries()) {
          summaryStep.value = `Resumindo ${name} (${index + 1}/${names.length})`;
          summaryPercent.value = 0;
          summaries.value.push(await api.atendimentosSummary(name, (percent) => (summaryPercent.value = percent), controller.signal));
        }
      } catch (e) {
        if (!controller.signal.aborted) summaryError.value = errorMessage(e);
      } finally {
        if (summaryController === controller) {
          summaryController = undefined;
          summaryStep.value = '';
        }
      }
    },
    (message) => (error.value = message),
  );
}

function stopAtendimentos(promotionName: string) {
  atendimentosControllers.get(promotionName)?.abort();
}

function stopAllAtendimentos() {
  for (const controller of atendimentosControllers.values()) controller.abort();
}

function closeAtendimentos(promotionName: string) {
  stopAtendimentos(promotionName);
  atendimentosOrder.value = atendimentosOrder.value.filter((name) => name !== promotionName);
}

async function runScan(totpCode: string | undefined) {
  stopAutoRefresh();
  whatsappSent.value = false;
  loading.value = true;
  error.value = '';
  progressPercent.value = 0;
  currentStep.value = '';
  promotions.value = [];
  scanned.value = false;
  const controller = new AbortController();
  scanController = controller;
  try {
    const result = await api.recurrencesScan(totpCode, (progress) => {
      currentStep.value = progress.label;
      if (progress.current !== undefined && progress.total) {
        progressPercent.value = Math.round((progress.current / progress.total) * 100);
      }
      if (progress.promotion) promotions.value.unshift(progress.promotion);
    }, controller.signal);
    promotions.value = [...result.promotions].reverse();
    scanned.value = true;
    startRefreshCountdown();
    startWhatsAppCountdown();
  } catch (e) {
    if (!controller.signal.aborted) error.value = errorMessage(e);
  } finally {
    progressPercent.value = 100;
    loading.value = false;
    scanController = undefined;
  }
}
</script>

<template>
  <div class="recurrencias-view">
    <span class="eyebrow">Ferramentas</span>
    <h1>Recorrências</h1>
    <p v-if="isDemo">
      Os dados vêm da API interna (Configurações → Conectores → API interna), que lê o painel de cada promoção sem alterar nada.
    </p>
    <p v-else>
      Certifique-se de estar autenticado no Monitor de Promoções em Configurações → Conectores → Monitor de Promoções
    </p>

    <div class="scan-actions">
      <button type="button" class="primary" :disabled="loading || sendingWhatsApp" @click="scan">
        {{ loading ? 'Consultando...' : 'Consultar promoções' }}
      </button>
      <button
        v-if="whatsappCountdown !== null || sendingWhatsApp"
        type="button"
        class="whatsapp-send"
        :disabled="sendingWhatsApp"
        @click="whatsappConfirmOpen = true"
      >
        {{ sendingWhatsApp ? 'Enviando WhatsApp...' : `Enviar WhatsApp (${whatsappCountdown}s)` }}
      </button>
      <button v-if="scanned && !loading" type="button" class="ghost" :disabled="loadingSlack" @click="openSlack">
        {{ loadingSlack ? 'Carregando...' : 'Enviar ao Slack' }}
      </button>
      <button v-if="atendimentosLoading" type="button" class="stop-tests" @click="stopAllAtendimentos">■ Parar consultas</button>
      <button v-else type="button" class="ghost" :disabled="loading || promotionsWithPanel.length === 0" @click="scanAllAtendimentos">
        Consultar atendimentos
      </button>
      <button type="button" class="ghost summary-button" @click="openSummaryPicker">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 8V4H8" />
          <rect x="4" y="8" width="16" height="12" rx="2" />
          <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
        </svg>
        Analisar atendimentos
      </button>
      <!-- <button type="button" disabled title="Em breve">Consultar cupons</button> -->
    </div>
    <div v-if="schedule" class="schedule-row">
      <label class="switch">
        <input
          type="checkbox"
          :checked="schedule.enabled"
          :disabled="savingSchedule"
          aria-labelledby="schedule-label"
          aria-describedby="schedule-last-run"
          @change="toggleSchedule"
        />
        <span class="switch-track"><span class="switch-thumb"></span></span>
      </label>
      <div class="schedule-text">
        <span id="schedule-label">Consultar e enviar WhatsApp automaticamente às {{ schedule.slots.join(', ') }}</span>
        <span v-if="schedule.lastRun" id="schedule-last-run" class="schedule-last-run" :class="{ failed: !schedule.lastRun.ok }">
          <template v-if="schedule.lastRun.ok">
            <i>Última consulta feita em {{ formatTime(schedule.lastRun.at) }} e resultado enviado via WhatsApp</i>
          </template>
          <template v-else>
            <i>Última consulta em {{ formatTime(schedule.lastRun.at) }}: {{ schedule.lastRun.message }}</i>
          </template>
        </span>
      </div>
    </div>
    <p v-if="refreshing || refreshCountdown !== null" class="refresh-countdown">
      {{ refreshing ? 'Atualizando contagem de acessos...' : `Atualização da contagem de acessos em ${refreshCountdown}s` }}
    </p>

    <div v-if="loading" class="progress-bar-row">
      <div class="progress-bar-track">
        <div class="progress-bar-fill" :style="{ width: `${progressPercent}%` }" />
      </div>
      <span class="progress-bar-percent">{{ progressPercent }}%</span>
      <span v-if="currentStep" class="progress-bar-step">{{ currentStep }}</span>
    </div>

    <p v-if="error" style="color: var(--danger)">{{ error }}</p>
    <p v-else-if="whatsappSent" class="whatsapp-sent">Mensagem enviada no WhatsApp.</p>

    <div class="recurrencias-layout" :class="{ 'with-atendimentos': atendimentosOrder.length > 0 }">
      <div>
        <TransitionGroup v-if="promotions.length > 0 || loading" tag="ul" name="promo-card" class="promotions-list">
          <li v-if="loading" key="__pending" class="promo-pending" aria-hidden="true">
            <span class="skeleton-line skeleton-title" />
            <span class="skeleton-line skeleton-body" />
          </li>
          <li v-for="promo in promotions" :key="promo.name" :class="{ 'promo-fail': !promo.ok }">
            <div class="promo-header">
              <span class="promo-title"> 
                <strong>{{ promo.name }}</strong>
                · acessos:
                <span v-if="refreshing" class="skeleton-line skeleton-count" aria-hidden="true" />
                <span v-else-if="promo.analyticsCount" class="analytics-count" :class="accessLevel(promo.analyticsCount)">{{ promo.analyticsCount }}</span>
              </span>
              <nav v-if="promo.panelLinks?.length" class="panel-links">
                <template v-for="link in promo.panelLinks" :key="link.url">
                  <a v-if="safeHttpUrl(link.url)" :href="safeHttpUrl(link.url)" target="_blank" rel="noopener noreferrer">{{ link.label }}</a>
                  <span v-else>{{ link.label }}</span>
                </template>
              </nav>
            </div>
            <template v-if="promo.ok">
              <span class="status-saved">recorrências ok</span>
              <ul v-if="promo.registrationLines.length > 0" class="registration-lines">
                <li v-for="reg in promo.registrationLines" :key="reg.label">{{ reg.label }}: {{ reg.value }}</li>
              </ul>
            </template>
            <ul v-else class="failing-lines">
              <li v-for="line in promo.failingLines" :key="line">{{ line }}</li>
            </ul>
          </li>
        </TransitionGroup>
        <p v-else-if="scanned">Nenhuma promoção encontrada.</p>
      </div>

      <TransitionGroup v-if="atendimentosOrder.length > 0" tag="aside" name="promo-card" class="atendimentos-column">
        <section v-for="name in atendimentosOrder" :key="name" class="atendimentos-card">
          <header class="atendimentos-card-header">
            <button
              type="button"
              class="atendimentos-toggle"
              :aria-expanded="expandedAtendimentos === name"
              @click="toggleAtendimentos(name)"
            >
              <span class="atendimentos-chevron" :class="{ open: expandedAtendimentos === name }" aria-hidden="true">▸</span>
              <span class="atendimentos-title">
                <strong>{{ name }}</strong>
                <span v-if="atendimentos[name].error" class="atendimentos-error">{{ atendimentos[name].error }}</span>
                <span v-else-if="atendimentos[name].loading" class="atendimentos-meta">{{ atendimentos[name].step || 'Consultando...' }}</span>
                <span v-else class="atendimentos-meta">{{ atendimentos[name].items.length }} atendimento(s) nos últimos dois dias</span>
              </span>
            </button>
            <button type="button" class="atendimentos-close" title="Fechar" aria-label="Fechar" @click="closeAtendimentos(name)">×</button>
          </header>
          <div class="atendimentos-collapse" :class="{ open: expandedAtendimentos === name }" :inert="expandedAtendimentos !== name">
            <div class="atendimentos-body">
              <div v-if="atendimentos[name].items.length > 0">
                <input
                  v-model="atendimentos[name].search"
                  type="search"
                  class="atendimentos-search"
                  placeholder="Buscar por ID, assunto, participante, mensagem..."
                  aria-label="Buscar atendimentos"
                />
              </div>
              <TransitionGroup tag="ul" name="promo-card" class="atendimentos-list">
                <li v-for="item in visibleItems(atendimentos[name])" :key="item.id">
                  <strong>#{{ item.id }} · {{ item.assunto }}</strong>
                  <span class="atendimentos-meta">{{ item.participante }} · {{ item.dataRecebimento }}</span>
                  <span class="atendimentos-status">{{ item.status }}</span>
                  <span class="atendimentos-message">{{ item.mensagem }}</span>
                </li>
              </TransitionGroup>
              <span v-if="atendimentos[name].loading" class="skeleton-line skeleton-body" aria-hidden="true" />
            </div>
          </div>
        </section>
      </TransitionGroup>
    </div>

    <PromotionPickerModal
      :open="summaryPickerOpen"
      title="Analisar os atendimentos de quais promoções?"
      :promotions="promotionsWithPanel.map((promo) => promo.name)"
      confirm-label="Resumir"
      @confirm="summarizeAtendimentos"
      @cancel="summaryPickerOpen = false"
    />
    <AtendimentosSummaryModal
      :open="summaryOpen"
      :summaries="selectedSummaries"
      :atendimentos="atendimentosByPromotion"
      :panel-urls="panelUrlsByPromotion"
      :step="summaryStep"
      :percent="summaryPercent"
      :error="summaryError"
      @close="summaryOpen = false"
    />

    <ConfirmModal
      :open="whatsappConfirmOpen"
      title="Enviar no WhatsApp?"
      :description="`O resultado da consulta de ${promotions.length} promoç${promotions.length === 1 ? 'ão' : 'ões'} vai para o grupo Recorrências no WhatsApp.`"
      confirm-label="Enviar no WhatsApp"
      cancel-label="Cancelar"
      @confirm="confirmWhatsApp"
      @cancel="whatsappConfirmOpen = false"
    />

    <SlackSendModal :open="slackText !== null" :text="slackText ?? ''" log-source="recorrencias" @close="slackText = null" />

    <TotpCodeModal
      :open="totpModalOpen"
      description="Digite o código atual do autenticador do Monitor de Promoções pra continuar."
      @confirm="confirmTotp"
      @cancel="closeTotp"
    />
  </div>
</template>

<style scoped>
.progress-bar-row {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 640px;
  margin-bottom: 12px;
}

.progress-bar-row .progress-bar-track {
  flex: 0 0 200px;
  margin: 0;
}

.progress-bar-percent {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  min-width: 34px;
  text-align: right;
}

.progress-bar-step {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recurrencias-layout {
  display: grid;
  grid-template-columns: minmax(0, 560px);
  gap: 16px;
  align-items: start;
}

.recurrencias-layout.with-atendimentos {
  grid-template-columns: minmax(0, 560px) minmax(0, 1fr);
}

@media (max-width: 960px) {
  .recurrencias-layout.with-atendimentos {
    grid-template-columns: minmax(0, 1fr);
  }

  .atendimentos-column {
    position: static;
    max-height: none;
  }
}

@media (max-width: 640px) {
  .promo-header {
    flex-wrap: wrap;
  }

  .panel-links {
    justify-content: flex-start;
    flex-shrink: 1;
  }

  .progress-bar-row {
    flex-wrap: wrap;
  }

  .progress-bar-row .progress-bar-track {
    flex: 1 1 auto;
  }

  .progress-bar-step {
    flex-basis: 100%;
  }
}

.promotions-list {
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.promotions-list > li {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent-green);
  border-radius: 8px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.promotions-list > li.promo-fail {
  border-left-color: var(--danger);
  background: var(--danger-soft);
}

.promo-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.promo-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.analytics-count {
  color: var(--accent-green);
  font-size: 13px;
  font-weight: bold;
}

.analytics-count.medium {
  color: var(--accent-orange);
}

.analytics-count.high {
  color: var(--danger);
}

.panel-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px 12px;
  flex-shrink: 0;
}

.panel-links a {
  color: var(--accent-orange);
  font-size: 13px;
  text-decoration: underline;
  text-underline-offset: 2px;
  opacity: 0.9;
  transition: opacity 0.15s ease;
  font-weight: bold;
}

.panel-links a:hover {
  opacity: 1;
}

.promotions-list > li.promo-pending {
  border-left-color: var(--border);
  gap: 8px;
}

.skeleton-line {
  display: block;
  height: 10px;
  border-radius: 5px;
  background: linear-gradient(90deg, var(--border) 25%, var(--surface) 50%, var(--border) 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.4s ease-in-out infinite;
}

.skeleton-title {
  width: 45%;
  height: 12px;
}

.skeleton-body {
  width: 70%;
}

.skeleton-count {
  display: inline-block;
  width: 40px;
  vertical-align: middle;
}

@keyframes skeleton-shimmer {
  from { background-position: 100% 0; }
  to { background-position: -100% 0; }
}

.promo-card-enter-active {
  transition: opacity 0.4s ease, transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}

.promo-card-move {
  transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}

.promo-card-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

@media (prefers-reduced-motion: reduce) {
  .promo-card-enter-active,
  .promo-card-move,
  .skeleton-line {
    transition: none;
    animation: none;
  }
}

.failing-lines {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.failing-lines li {
  color: var(--danger);
  font-size: 13px;
}

.registration-lines {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.refresh-countdown {
  margin: -4px 0 12px;
  font-size: 13px;
  opacity: 0.8;
}

button.whatsapp-send {
  background: var(--accent-green);
  color: #0b1f12;
}

button.whatsapp-send:hover {
  filter: brightness(1.08);
}

.whatsapp-sent {
  color: var(--accent-green);
}

.schedule-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  align-items: center;
  margin: 0 0 12px;
  font-size: 13px;
}

.schedule-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.schedule-last-run {
  opacity: 0.8;
}

.schedule-last-run.failed {
  color: var(--danger);
  opacity: 1;
}

.scan-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
}

.summary-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.atendimentos-column {
  position: sticky;
  top: 16px;
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
}

.atendimentos-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent-orange);
  border-radius: 8px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
}

.atendimentos-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.atendimentos-toggle {
  flex: 1;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: none;
  border: none;
  padding: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.atendimentos-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.atendimentos-chevron {
  color: var(--text-secondary);
  transition: transform 0.15s ease;
}

.atendimentos-chevron.open {
  transform: rotate(90deg);
}

.atendimentos-collapse {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows 0.25s ease, opacity 0.25s ease;
}

.atendimentos-collapse.open {
  grid-template-rows: 1fr;
  opacity: 1;
}

.atendimentos-body {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
}

.atendimentos-close {
  background: none;
  border: none;
  padding: 0 4px;
  color: var(--text-secondary);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.atendimentos-close:hover {
  color: var(--text-primary);
}


.atendimentos-search {
  flex: 1;
  min-width: min(200px, 100%);
  font-size: 13px;
}

.atendimentos-error {
  color: var(--danger);
  font-size: 13px;
}

.atendimentos-meta {
  color: var(--text-secondary);
  font-size: 13px;
}

.atendimentos-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.atendimentos-list li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  border-top: 1px solid var(--border);
  padding-top: 6px;
}

.atendimentos-status {
  align-self: flex-start;
  font-size: 12px;
  font-weight: bold;
  color: var(--accent-orange);
}

.atendimentos-message {
  white-space: pre-wrap;
}

.registration-lines li {
  color: var(--text-secondary);
  font-size: 13px;
}
</style>
