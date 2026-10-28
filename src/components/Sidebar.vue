<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { PromotionStage } from '../../promotions/types';
import { api, type PromotionSummary } from '../api';
import { authState } from '../auth-state';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useModalDialog } from '../composables/useModalDialog';
import { errorMessage } from '../composables/utils';
import ConnectorsMenu from './ConnectorsMenu.vue';
import AppCredit from './AppCredit.vue';
import CollapseSection from './CollapseSection.vue';
import NavIcon from './NavIcon.vue';

defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();

const promotions = ref<PromotionSummary[]>([]);
const route = useRoute();
const router = useRouter();

// Dev depende de pastas locais que só o Master configura.
const defaultEnv = computed(() => (authState.role === 'master' ? 'dev' : 'homolog'));

const promotionToDelete = ref<PromotionSummary | null>(null);
const { pending: deleting, error: deleteError, run } = useAsyncAction();
const { error: listError, run: runList } = useAsyncAction();
const deleteDialog = ref<HTMLElement | null>(null);
useModalDialog(deleteDialog, () => Boolean(promotionToDelete.value));

function refresh() {
  return runList(async () => {
    promotions.value = await api.listPromotions();
  });
}

refresh();
watch(() => route.params.id, refresh);

const STAGE_SECTIONS: { stage: PromotionStage; title: string }[] = [
  { stage: 'testing', title: 'Em Testes' },
  { stage: 'live', title: 'No Ar' },
  { stage: 'closed', title: 'Encerrados' },
];
const promotionsByStage = computed(() =>
  Object.fromEntries(STAGE_SECTIONS.map(({ stage }) => [stage, promotions.value.filter((p) => p.stage === stage)])),
);
const draggedId = ref<string | null>(null);
const dropTarget = ref<PromotionStage | null>(null);
const stageError = ref('');

function startDrag(event: DragEvent, id: string) {
  draggedId.value = id;
  event.dataTransfer?.setData('text/plain', id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

async function dropOn(stage: PromotionStage) {
  const promotion = promotions.value.find((p) => p.id === draggedId.value);
  draggedId.value = null;
  dropTarget.value = null;
  if (!promotion || promotion.stage === stage) return;
  const previous = promotion.stage;
  promotion.stage = stage;
  stageError.value = '';
  try {
    await api.setPromotionStage(promotion.id, stage);
  } catch (e) {
    promotion.stage = previous;
    stageError.value = errorMessage(e);
  }
}

function askDelete(p: PromotionSummary) {
  promotionToDelete.value = p;
  deleteError.value = '';
}

function cancelDelete() {
  if (deleting.value) return;
  promotionToDelete.value = null;
}

async function confirmDelete() {
  const p = promotionToDelete.value;
  if (!p) return;
  await run(async () => {
    await api.deletePromotion(p.id);
    promotionToDelete.value = null;
    if (route.params.id === p.id) router.push('/');
    await refresh();
  });
}
</script>

<template>
  <div v-if="open" class="sidebar-scrim" aria-hidden="true" @click="$emit('close')"></div>
  <aside class="sidebar themed-scrollbar" :class="{ open }" @keydown.esc="$emit('close')">
    <div class="brand">
      <h2>Promoções</h2>
    </div>

    <router-link to="/promotions/new" class="new-promotion"><NavIcon name="plus" />Nova promoção</router-link>

    <p v-if="listError" class="empty" style="color: var(--danger)">{{ listError }}</p>
    <p v-else-if="promotions.length === 0" class="empty">Nenhuma promoção cadastrada ainda.</p>

    <p v-if="stageError" class="empty" style="color: var(--danger)">{{ stageError }}</p>

    <div
      v-for="section in STAGE_SECTIONS"
      :key="section.stage"
      class="stage-section"
      :class="{ 'drop-target': dropTarget === section.stage }"
      @dragover.prevent="draggedId && (dropTarget = section.stage)"
      @dragleave.self="dropTarget = null"
      @drop.prevent="dropOn(section.stage)"
    >
      <CollapseSection :title="`${section.title} (${promotionsByStage[section.stage]!.length})`" :icon="section.stage" :default-open="section.stage === 'testing'">
        <nav class="history">
          <p v-if="promotionsByStage[section.stage]!.length === 0" class="empty stage-empty">Arraste uma promoção para cá.</p>
          <div
            v-for="p in promotionsByStage[section.stage]"
            :key="p.id"
            class="history-item"
            :class="{ active: route.params.id === p.id, dragging: draggedId === p.id }"
            draggable="true"
            @dragstart="startDrag($event, p.id)"
            @dragend="draggedId = null; dropTarget = null"
          >
            <router-link :to="`/promotions/${p.id}/${defaultEnv}`" class="history-item-text" :aria-current="route.params.id === p.id ? 'page' : undefined">
              <strong>{{ p.name }}</strong>
              <span>{{ p.client }}</span>
            </router-link>
            <button
              v-if="authState.role === 'master'"
              type="button"
              class="history-item-delete"
              title="Excluir promoção"
              :aria-label="`Excluir promoção ${p.name}`"
              @click="askDelete(p)"
            >
              <NavIcon name="trash" />
            </button>
          </div>
        </nav>
      </CollapseSection>
    </div>

    <hr v-if="authState.authenticated" class="sidebar-divider" />

    <div v-if="authState.authenticated" class="sidebar-footer-group">
      <CollapseSection title="Ferramentas" icon="tools">
        <ul class="tools-list">
          <li>
            <router-link to="/recorrencias" class="tools-list-item"><NavIcon name="recurrences" />Recorrências</router-link>
          </li>
          <li>
            <router-link to="/conectores/monday" class="tools-list-item"><NavIcon name="board" />Monday</router-link>
          </li>
        </ul>
      </CollapseSection>
      <CollapseSection title="Configurações" icon="settings">
        <CollapseSection title="Conectores" icon="connectors">
          <ConnectorsMenu />
        </CollapseSection>
        <ul class="tools-list">
          <li>
            <router-link to="/configuracoes/aprendizado" class="tools-list-item"><NavIcon name="learning" />Aprendizado</router-link>
          </li>
          <li v-if="authState.role === 'master'">
            <router-link to="/configuracoes/usuarios" class="tools-list-item"><NavIcon name="users" />Usuários</router-link>
          </li>
          <li v-if="authState.role === 'master'">
            <router-link to="/configuracoes/demo" class="tools-list-item"><NavIcon name="users" />Contas da demo</router-link>
          </li>
        </ul>
      </CollapseSection>
      <ul class="tools-list">
        <li>
          <router-link to="/logs" class="tools-list-item"><NavIcon name="logs" />Logs</router-link>
        </li>
      </ul>
    </div>

    <AppCredit class="sidebar-credit" />

    <div v-if="promotionToDelete" class="modal-backdrop" @keydown.esc="cancelDelete">
      <div ref="deleteDialog" class="card modal-card" role="dialog" aria-modal="true" aria-label="Excluir promoção?">
        <h3>Excluir promoção?</h3>
        <p>
          Isso apaga <strong>{{ promotionToDelete.name }}</strong> ({{ promotionToDelete.client }}) e
          todos os dados salvos dela (ambientes, credenciais, mecânica). Não tem como desfazer.
        </p>
        <p v-if="deleteError" style="color: var(--danger)">{{ deleteError }}</p>
        <div class="card-footer">
          <button type="button" class="ghost" :disabled="deleting" @click="cancelDelete">Cancelar</button>
          <button type="button" class="danger" :disabled="deleting" @click="confirmDelete">
            {{ deleting ? 'Excluindo...' : 'Excluir' }}
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 260px;
  flex-shrink: 0;
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: 20px 16px;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.sidebar-divider {
  width: 100%;
  border: none;
  border-top: 1px solid var(--border);
  margin: 16px 0;
}

.sidebar-footer-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sidebar-credit {
  margin-top: auto;
  padding-top: 20px;
}

.brand {
  margin-bottom: 20px;
}

.brand h2 {
  font-size: 18px;
}

.new-promotion {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--accent-orange-soft);
  color: var(--accent-orange);
  border: 1px dashed var(--accent-orange);
  border-radius: 8px;
  padding: 10px;
  text-decoration: none;
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 20px;
}

.new-promotion .nav-icon {
  color: inherit;
}

.new-promotion:hover {
  background: var(--accent-orange);
  color: #1a1005;
}

.empty {
  font-size: 13px;
}

.stage-section {
  border-radius: 8px;
  margin-bottom: 8px;
  outline: 1px dashed transparent;
  transition: outline-color 0.15s ease, background 0.15s ease;
}

.stage-section.drop-target {
  outline-color: var(--accent-orange);
  background: var(--accent-orange-soft);
}

.stage-empty {
  padding: 8px 4px;
  color: var(--text-secondary);
}

.history-item.dragging {
  opacity: 0.4;
}

.history {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 8px;
  border-radius: 8px;
  border-left: 3px solid transparent;
}

.history-item-text {
  padding: 10px 0 10px 12px;
}

.history-item-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  text-decoration: none;
  border-radius: 4px;
}

.history-item strong {
  color: var(--text-primary);
  font-size: 14px;
}

.history-item span {
  color: var(--text-secondary);
  font-size: 12px;
}

.history-item:hover {
  background: var(--surface-hover);
}

.history-item.active {
  background: var(--surface-hover);
  border-left-color: var(--accent-orange);
}

.history-item-delete {
  flex-shrink: 0;
  background: transparent;
  border: none;
  padding: 4px 6px;
  font-size: 14px;
  line-height: 1;
  opacity: 0;
  color: var(--text-secondary);
}

.history-item:hover .history-item-delete,
.history-item:focus-within .history-item-delete {
  opacity: 1;
}

.history-item-delete .nav-icon {
  display: block;
  color: inherit;
}

.history-item-delete:hover {
  color: var(--danger);
  background: var(--danger-soft);
  border-radius: 6px;
}

.tools-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.tools-list-item {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
  font-weight: 500;
  text-decoration: none;
  padding: 8px 4px;
  border-radius: 6px;
}

.tools-list-item:hover {
  background: var(--surface-hover);
}

.sidebar-scrim {
  display: none;
}

@media (max-width: 900px) {
  .sidebar {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 40;
    width: min(300px, 85vw);
    transform: translateX(-100%);
    visibility: hidden;
    transition: transform 0.2s ease, visibility 0.2s;
    box-shadow: 8px 0 24px rgba(0, 0, 0, 0.35);
  }

  .sidebar.open {
    transform: none;
    visibility: visible;
  }

  .sidebar-scrim {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 39;
    background: rgba(10, 10, 24, 0.6);
  }

  /* Sem hover no toque: a lixeira fica sempre visível. */
  .history-item-delete {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sidebar {
    transition: none;
  }
}
</style>
