<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api, type Atendimento, type AtendimentosSummary, type Severity } from '../api';
import { useModalDialog } from '../composables/useModalDialog';
import { SEVERITY_LABELS, errorMessage } from '../composables/utils';
import ConfirmModal from './ConfirmModal.vue';
import SlackSendModal from './SlackSendModal.vue';

const props = defineProps<{
  open: boolean;
  summaries: AtendimentosSummary[];
  atendimentos: Record<string, Atendimento[]>;
  panelUrls: Record<string, string>;
  step: string;
  percent: number;
  error: string;
}>();
const emit = defineEmits<{ close: [] }>();

const dialog = ref<HTMLElement | null>(null);
useModalDialog(dialog, () => props.open);

const selected = ref<{ promotionName: string; atendimento: Atendimento } | null>(null);
const detailDialog = ref<HTMLElement | null>(null);
useModalDialog(detailDialog, () => selected.value !== null);

function findAtendimento(promotionName: string, id: string): Atendimento | undefined {
  return props.atendimentos[promotionName]?.find((item) => item.id === id);
}

const labeledIds = ref<Record<string, Set<string>>>({});
const confirming = ref<Set<string>>(new Set());
const confirmError = ref('');

function isLabeled(promotionName: string, id: string): boolean {
  return labeledIds.value[promotionName]?.has(id) ?? false;
}

function markLabeled(promotionName: string, id: string) {
  labeledIds.value = { ...labeledIds.value, [promotionName]: new Set([...(labeledIds.value[promotionName] ?? []), id]) };
}

/** Busca só as promoções novas e soma ao que já há: uma resposta atrasada não apaga as outras nem o que `markLabeled` marcou. */
const fetchedLabels = new Set<string>();
watch(
  () => props.summaries.map((summary) => summary.promotionName).join('|'),
  async () => {
    const missing = props.summaries.map((summary) => summary.promotionName).filter((name) => !fetchedLabels.has(name));
    for (const name of missing) fetchedLabels.add(name);
    await Promise.all(
      missing.map(async (promotionName) => {
        const labels = await api.atendimentoLabels(promotionName).catch(() => {
          fetchedLabels.delete(promotionName);
          return [];
        });
        const ids = new Set([...(labeledIds.value[promotionName] ?? []), ...labels.map((label) => label.atendimentoId)]);
        labeledIds.value = { ...labeledIds.value, [promotionName]: ids };
      }),
    );
  },
  { immediate: true },
);

const confirmKey = (promotionName: string, id: string) => `${promotionName}#${id}`;

async function confirmSeverity(promotionName: string, id: string, severity: Severity, tema: string) {
  const key = confirmKey(promotionName, id);
  confirming.value = new Set([...confirming.value, key]);
  confirmError.value = '';
  try {
    await api.saveAtendimentoLabel({ promotionName, atendimentoId: id, severity, tema });
    markLabeled(promotionName, id);
  } catch (e) {
    confirmError.value = errorMessage(e);
  } finally {
    confirming.value = new Set([...confirming.value].filter((item) => item !== key));
  }
}

const reviewQueue = computed(() =>
  props.summaries.flatMap((summary) =>
    summary.reviewFirst
      .filter((item) => !isLabeled(summary.promotionName, item.id) && findAtendimento(summary.promotionName, item.id))
      .map((item) => ({ promotionName: summary.promotionName, ...item })),
  ),
);

const labelSeverity = ref<Severity>('media');
const labelTema = ref('');
const labelStatus = ref('');
const savingLabel = ref(false);

function currentGroupOf(promotionName: string, id: string) {
  return props.summaries.find((summary) => summary.promotionName === promotionName)?.groups.find((group) => group.ids.includes(id));
}

async function openAtendimento(promotionName: string, id: string) {
  const atendimento = findAtendimento(promotionName, id);
  if (!atendimento) return;
  selected.value = { promotionName, atendimento };
  const group = currentGroupOf(promotionName, id);
  labelSeverity.value = group?.severity ?? 'media';
  labelTema.value = group?.tema ?? '';
  labelStatus.value = '';
  try {
    const saved = (await api.atendimentoLabels(promotionName)).find((label) => label.atendimentoId === id);
    if (saved && selected.value?.atendimento.id === id) {
      labelSeverity.value = saved.severity;
      labelTema.value = saved.tema ?? labelTema.value;
      labelStatus.value = 'Já corrigido pela equipe.';
    }
  } catch {
    labelStatus.value = 'Não deu pra ler as correções salvas.';
  }
}

const elapsedSeconds = ref(0);
let elapsedTimer: ReturnType<typeof setInterval> | undefined;

watch(
  () => !!props.step,
  (loading) => {
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
    if (!loading) return;
    const startedAt = Date.now();
    elapsedSeconds.value = 0;
    elapsedTimer = setInterval(() => (elapsedSeconds.value = Math.floor((Date.now() - startedAt) / 1000)), 1000);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearInterval(elapsedTimer));

const elapsedLabel = computed(() => {
  const minutes = Math.floor(elapsedSeconds.value / 60);
  return `${String(minutes).padStart(2, '0')}:${String(elapsedSeconds.value % 60).padStart(2, '0')}`;
});

const sendingWhatsApp = ref(false);
const whatsappStatus = ref('');
watch(
  () => props.step,
  (step) => {
    if (step) whatsappStatus.value = '';
  },
);

const whatsappConfirmOpen = ref(false);

async function confirmWhatsApp() {
  whatsappConfirmOpen.value = false;
  sendingWhatsApp.value = true;
  whatsappStatus.value = '';
  try {
    await api.recurrencesWhatsApp(undefined, props.summaries.map((summary) => summary.promotionName));
    whatsappStatus.value = 'Enviado no grupo Recorrências.';
  } catch (e) {
    whatsappStatus.value = errorMessage(e);
  } finally {
    sendingWhatsApp.value = false;
  }
}

const slackText = ref<string | null>(null);
const loadingSlack = ref(false);

async function openSlack() {
  loadingSlack.value = true;
  whatsappStatus.value = '';
  try {
    slackText.value = await api.recurrencesMessage(props.summaries.map((summary) => summary.promotionName));
  } catch (e) {
    whatsappStatus.value = errorMessage(e);
  } finally {
    loadingSlack.value = false;
  }
}

async function saveLabel() {
  if (!selected.value) return;
  savingLabel.value = true;
  try {
    await api.saveAtendimentoLabel({
      promotionName: selected.value.promotionName,
      atendimentoId: selected.value.atendimento.id,
      severity: labelSeverity.value,
      tema: labelTema.value.trim() || null,
    });
    markLabeled(selected.value.promotionName, selected.value.atendimento.id);
    labelStatus.value = 'Gravidade salva — vale a partir do próximo resumo.';
  } catch (e) {
    labelStatus.value = errorMessage(e);
  } finally {
    savingLabel.value = false;
  }
}

const sections = computed(() =>
  (Object.keys(SEVERITY_LABELS) as Severity[])
    .filter((severity) => severity !== 'externo')
    .map((severity) => ({
      severity,
      label: SEVERITY_LABELS[severity],
      entries: props.summaries.flatMap((summary) =>
        summary.groups.filter((group) => group.severity === severity).map((group) => ({ promotionName: summary.promotionName, ...group })),
      ),
    }))
    .filter((section) => section.entries.length > 0),
);
</script>

<template>
  <div v-if="open" class="modal-backdrop" @keydown.esc="emit('close')">
    <div ref="dialog" class="card modal-card summary-modal-card" role="dialog" aria-modal="true" aria-label="Resumo dos atendimentos">
      <h3>Resumo dos atendimentos</h3>
      <div class="summary-body">
        <p v-if="error" style="color: var(--danger)">{{ error }}</p>
        <div v-if="step" class="summary-progress">
          <div class="summary-progress-header">
            <span class="summary-step">{{ step }} — {{ percent === 0 ? 'lendo atendimentos...' : `${percent}%` }}</span>
            <span class="summary-elapsed" aria-label="Tempo decorrido">⏱ {{ elapsedLabel }}</span>
          </div>
          <div class="progress-bar-track">
            <div class="progress-bar-fill" :style="{ width: `${percent}%` }" />
          </div>
        </div>

        <section v-if="summaries.length > 0" class="summary-section overview">
          <h4>Visão geral</h4>
          <ul>
            <li v-for="summary in summaries" :key="summary.promotionName">
              <div class="overview-header">
                <strong>{{ summary.promotionName }}</strong>
                <a v-if="panelUrls[summary.promotionName]" :href="panelUrls[summary.promotionName]" target="_blank" rel="noopener" class="panel-link">ir para o painel</a>
              </div>
              <span>{{ summary.visaoGeral }}</span>
              <span v-if="summary.note" class="summary-note">{{ summary.note }}</span>
              <span v-if="summary.examples" class="summary-note">Usou {{ summary.examples }} exemplo(s) corrigido(s) pela equipe.</span>
              <span v-if="summary.classified" class="summary-note">
                Gravidade de {{ summary.classified }} atendimento(s) definida pelo classificador treinado com {{ summary.labels }} correção(ões).
              </span>
              <span v-else-if="summary.learningStatus" class="summary-note">{{ summary.learningStatus }}</span>
            </li>
          </ul>
        </section>

        <section v-if="reviewQueue.length > 0" class="summary-section review-first">
          <h4>Revise estes primeiro</h4>
          <p class="summary-note">É onde o sistema tem menos certeza: confirmar ou corrigir estes ensina mais que os óbvios.</p>
          <ul>
            <li v-for="item in reviewQueue" :key="`${item.promotionName}-${item.id}`">
              <span>
                <button type="button" class="summary-id-link" @click="openAtendimento(item.promotionName, item.id)">#{{ item.id }}</button>
                · {{ item.promotionName }}
              </span>
              <span class="summary-note">{{ item.reason }}</span>
            </li>
          </ul>
        </section>

        <p v-if="confirmError" style="color: var(--danger)">{{ confirmError }}</p>

        <section v-for="section in sections" :key="section.severity" class="summary-section" :class="`severity-${section.severity}`">
          <h4>{{ section.label }} ({{ section.entries.reduce((total, entry) => total + entry.ids.length, 0) }})</h4>
          <ul>
            <li v-for="entry in section.entries" :key="`${entry.promotionName}-${entry.tema}`">
              <strong>{{ entry.promotionName }} · {{ entry.tema }}</strong>
              <span>{{ entry.resumo }}</span>
              <span class="summary-ids">
                <template v-for="(id, index) in entry.ids" :key="id">
                  <button
                    v-if="findAtendimento(entry.promotionName, id)"
                    type="button"
                    class="summary-id-link"
                    @click="openAtendimento(entry.promotionName, id)"
                  >#{{ id }}</button>
                  <span v-else>#{{ id }}</span>
                  <span v-if="isLabeled(entry.promotionName, id)" class="confirmed-mark" title="Gravidade já confirmada ou corrigida">✓</span>
                  <button
                    v-else-if="findAtendimento(entry.promotionName, id)"
                    type="button"
                    class="confirm-button"
                    :disabled="confirming.has(confirmKey(entry.promotionName, id))"
                    :title="`Está certo: confirmar #${id} como ${section.label}`"
                    :aria-label="`Confirmar #${id} como ${section.label}`"
                    @click="confirmSeverity(entry.promotionName, id, section.severity, entry.tema)"
                  >✓</button>{{ index < entry.ids.length - 1 ? ', ' : '' }}
                </template>
              </span>
            </li>
          </ul>
        </section>
      </div>
      <div class="card-footer">
        <div class="whatsapp-actions">
          <button v-if="!step && summaries.length > 0" type="button" class="whatsapp-send" :disabled="sendingWhatsApp" @click="whatsappConfirmOpen = true">
            {{ sendingWhatsApp ? 'Enviando...' : 'Enviar para WhatsApp' }}
          </button>
          <button v-if="!step && summaries.length > 0" type="button" class="ghost" :disabled="loadingSlack" @click="openSlack">
            {{ loadingSlack ? 'Carregando...' : 'Enviar ao Slack' }}
          </button>
          <span v-if="whatsappStatus" class="summary-note">{{ whatsappStatus }}</span>
        </div>
        <button type="button" class="ghost" @click="emit('close')">Fechar</button>
      </div>
    </div>

    <div v-if="selected" class="modal-backdrop" @keydown.esc.stop="selected = null">
      <div ref="detailDialog" class="card modal-card atendimento-modal-card" role="dialog" aria-modal="true" :aria-label="`Atendimento #${selected.atendimento.id}`">
        <h3>#{{ selected.atendimento.id }} · {{ selected.atendimento.assunto }}</h3>
        <dl class="atendimento-fields">
          <dt>Promoção</dt>
          <dd>{{ selected.promotionName }}</dd>
          <dt>Participante</dt>
          <dd>{{ selected.atendimento.participante }}</dd>
          <dt>Recebido em</dt>
          <dd>{{ selected.atendimento.dataRecebimento }}</dd>
          <dt>Status</dt>
          <dd>{{ selected.atendimento.status || '(sem status)' }}</dd>
        </dl>
        <p class="atendimento-message">{{ selected.atendimento.mensagem }}</p>
        <form class="label-form" @submit.prevent="saveLabel">
          <span class="label-form-title">Confirmar ou corrigir gravidade</span>
          <div class="label-form-row">
            <select v-model="labelSeverity" aria-label="Gravidade">
              <option v-for="(label, severity) in SEVERITY_LABELS" :key="severity" :value="severity">{{ label }}</option>
            </select>
            <input v-model="labelTema" type="text" maxlength="255" placeholder="Tema (opcional)" aria-label="Tema" />
            <button type="submit" class="primary" :disabled="savingLabel">{{ savingLabel ? 'Salvando...' : 'Salvar' }}</button>
          </div>
          <span v-if="labelStatus" class="label-form-status">{{ labelStatus }}</span>
        </form>
        <div class="card-footer">
          <span />
          <button type="button" class="ghost" @click="selected = null">Fechar</button>
        </div>
      </div>
    </div>
    <SlackSendModal :open="slackText !== null" :text="slackText ?? ''" log-source="recorrencias" @close="slackText = null" />
    <ConfirmModal
      :open="whatsappConfirmOpen"
      title="Enviar no WhatsApp?"
      :description="`O resultado das Recorrências e o resumo de ${summaries.map((summary) => summary.promotionName).join(', ')} vão para o grupo Recorrências no WhatsApp.`"
      confirm-label="Enviar no WhatsApp"
      cancel-label="Cancelar"
      @confirm="confirmWhatsApp"
      @cancel="whatsappConfirmOpen = false"
    />
  </div>
</template>

<style scoped>
.whatsapp-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

button.whatsapp-send {
  background: var(--accent-green);
  color: #0b1f12;
}

button.whatsapp-send:hover:not(:disabled) {
  filter: brightness(1.08);
}

button.whatsapp-send:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.summary-id-link {
  all: unset;
  cursor: pointer;
  color: var(--accent-blue);
  text-decoration: underline;
}

.overview-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}

.panel-link {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-orange);
  white-space: nowrap;
}

.confirm-button {
  all: unset;
  cursor: pointer;
  margin-left: 2px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-secondary);
}

.confirm-button:hover:not(:disabled) {
  color: var(--accent-green);
  border-color: var(--accent-green);
}

.confirm-button:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 1px;
}

.confirm-button:disabled {
  opacity: 0.5;
  cursor: wait;
}

.confirmed-mark {
  margin-left: 2px;
  color: var(--accent-green);
}

.review-first {
  border-left-color: var(--accent-blue);
}

.summary-id-link:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 1px;
}

.atendimento-modal-card {
  max-width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.atendimento-fields {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0 0 12px;
  font-size: 13px;
}

.atendimento-fields dt {
  color: var(--text-secondary);
}

.atendimento-fields dd {
  margin: 0;
}

.label-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
  margin-bottom: 12px;
}

.label-form-title {
  font-size: 13px;
  font-weight: 600;
}

.label-form-row {
  display: flex;
  gap: 8px;
}

.label-form-row select {
  width: auto;
}

.label-form-row input {
  flex: 1;
  min-width: 0;
}

.label-form-status {
  color: var(--text-secondary);
  font-size: 13px;
}

.atendimento-message {
  white-space: pre-wrap;
  overflow-y: auto;
  font-size: 14px;
  margin: 0 0 12px;
}

.summary-modal-card {
  max-width: 760px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.summary-body {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 12px;
}

.summary-step,
.summary-note,
.summary-ids {
  color: var(--text-secondary);
  font-size: 13px;
}

.summary-note {
  display: block;
}

.summary-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.summary-progress-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}

.summary-elapsed {
  color: var(--text-secondary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.summary-progress .progress-bar-track {
  margin: 0;
}

.summary-section {
  border-left: 3px solid var(--border);
  padding-left: 12px;
}

.summary-section h4 {
  margin: 0 0 6px;
}

.summary-section ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}

.summary-section li {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.severity-critica {
  border-left-color: var(--danger);
}

.severity-critica h4 {
  color: var(--danger);
}

.severity-alta {
  border-left-color: var(--accent-orange);
}

.severity-alta h4 {
  color: var(--accent-orange);
}

.severity-media {
  border-left-color: var(--accent-blue);
}

.severity-baixa {
  border-left-color: var(--accent-green);
}

.severity-externo {
  border-left-color: var(--text-secondary);
}

.severity-externo h4 {
  color: var(--text-secondary);
}
</style>
