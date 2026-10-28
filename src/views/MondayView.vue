<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, type MondayBoardDetail, type MondayColumn, type MondayGroup, type MondayItem, type MondayItemColumnValue, type MondayWorkspaceBoards } from '../api';
import MondayCell from '../components/MondayCell.vue';
import MondayItemPanel from '../components/MondayItemPanel.vue';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useMondayUsers } from '../composables/useMondayUsers';
import { errorMessage } from '../composables/utils';

const props = defineProps<{ boardId?: string }>();
const router = useRouter();

const workspaces = ref<MondayWorkspaceBoards[]>([]);
const loadingBoards = ref(true);
const loadError = ref('');

const selectedBoard = ref<{ id: string; name: string } | null>(null);
const boardDetail = ref<MondayBoardDetail | null>(null);
const loadingBoardDetail = ref(false);
const boardDetailError = ref('');
let boardToken = 0;

interface GroupState {
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  items: MondayItem[];
  cursor: string | null;
  error: string;
}

const groupState = reactive<Record<string, GroupState>>({});

const { users, ensureUsersLoaded } = useMondayUsers();

const newGroupName = ref('');
const { pending: creatingGroup, error: createGroupError, run: runCreateGroup } = useAsyncAction();

const panelMode = ref<'create' | 'edit' | null>(null);
const panelItem = ref<MondayItem | null>(null);
const activeGroupId = ref('');

// `name` duplica a coluna fixa "Item".
const visibleColumns = computed(() => boardDetail.value?.columns.filter((c) => c.type !== 'name') ?? []);

const colTemplate = computed(() => {
  const columnCount = visibleColumns.value.length;
  return `32px minmax(200px, 1.4fr) repeat(${columnCount}, minmax(130px, 1fr))`;
});

async function loadWorkspaces() {
  loadingBoards.value = true;
  loadError.value = '';
  try {
    workspaces.value = await api.mondayBoards();
    if (props.boardId) {
      const board = workspaces.value.flatMap((ws) => ws.boards).find((b) => b.id === props.boardId);
      if (board) await selectBoard(board);
    }
  } catch (e) {
    loadError.value = errorMessage(e);
  } finally {
    loadingBoards.value = false;
  }
}

loadWorkspaces();

function freshGroupState(): GroupState {
  return { expanded: true, loaded: false, loading: false, items: [], cursor: null, error: '' };
}

async function selectBoard(board: { id: string; name: string }) {
  const token = ++boardToken;
  selectedBoard.value = board;
  if (router.currentRoute.value.params.boardId !== board.id) {
    router.replace({ name: 'monday', params: { boardId: board.id } });
  }
  boardDetail.value = null;
  boardDetailError.value = '';
  closePanel();
  for (const key of Object.keys(groupState)) delete groupState[key];
  loadingBoardDetail.value = true;
  try {
    const detail = await api.mondayBoardDetail(board.id);
    if (token !== boardToken) return;
    if (detail.columns.some((c) => c.type === 'people')) await ensureUsersLoaded();
    if (token !== boardToken) return;
    for (const group of detail.groups) groupState[group.id] = freshGroupState();
    boardDetail.value = detail;
    await Promise.all(detail.groups.map((g) => loadGroupItems(g.id)));
  } catch (e) {
    if (token === boardToken) boardDetailError.value = errorMessage(e);
  } finally {
    if (token === boardToken) loadingBoardDetail.value = false;
  }
}

watch(() => props.boardId, (boardId) => {
  if (!boardId || boardId === selectedBoard.value?.id) return;
  const board = workspaces.value.flatMap((ws) => ws.boards).find((b) => b.id === boardId);
  if (board) selectBoard(board);
});

async function loadGroupItems(groupId: string, append = false) {
  const state = groupState[groupId];
  const boardId = selectedBoard.value?.id;
  if (!boardId || !state) return;
  state.loading = true;
  state.error = '';
  try {
    const page = await api.mondayItems(boardId, groupId, append ? state.cursor : null);
    if (boardId !== selectedBoard.value?.id) return;
    state.items = append ? [...state.items, ...page.items] : page.items;
    state.cursor = page.cursor;
    state.loaded = true;
  } catch (e) {
    state.error = errorMessage(e);
  } finally {
    state.loading = false;
  }
}

function toggleGroup(groupId: string) {
  const state = groupState[groupId];
  if (!state) return;
  state.expanded = !state.expanded;
  if (state.expanded && !state.loaded) loadGroupItems(groupId);
}

async function createGroup() {
  const boardId = selectedBoard.value?.id;
  if (!boardId || !newGroupName.value.trim() || creatingGroup.value) return;
  await runCreateGroup(async () => {
    const group = await api.mondayCreateGroup(boardId, newGroupName.value.trim());
    newGroupName.value = '';
    if (boardId !== selectedBoard.value?.id || !boardDetail.value) return;
    boardDetail.value.groups.push(group);
    groupState[group.id] = freshGroupState();
    await loadGroupItems(group.id);
  });
}

function openCreatePanel(groupId: string) {
  activeGroupId.value = groupId;
  panelItem.value = null;
  panelMode.value = 'create';
}

function openEditPanel(item: MondayItem, groupId: string) {
  activeGroupId.value = groupId;
  panelItem.value = item;
  panelMode.value = 'edit';
}

function closePanel() {
  panelMode.value = null;
  panelItem.value = null;
}

async function onPanelChanged() {
  closePanel();
  if (activeGroupId.value) await loadGroupItems(activeGroupId.value);
}

function columnValue(item: MondayItem, columnId: string) {
  return item.columnValues.find((cv) => cv.columnId === columnId);
}

function onCellUpdated(item: MondayItem, cv: MondayItemColumnValue) {
  const idx = item.columnValues.findIndex((c) => c.columnId === cv.columnId);
  if (idx >= 0) item.columnValues[idx] = cv;
  else item.columnValues.push(cv);
}

// "Subitems" não vem em `column_values`; o painel do item é que carrega os subitens.
function onCellClick(e: MouseEvent, column: MondayColumn, item: MondayItem, groupId: string) {
  e.stopPropagation();
  if (column.type === 'subtasks') openEditPanel(item, groupId);
}

function groupOf(group: MondayGroup): GroupState {
  return groupState[group.id] ?? freshGroupState();
}
</script>

<template>
  <div class="monday-view">
    <header class="monday-header">
      <div>
        <router-link to="/" class="back-link">← Voltar</router-link>
        <h2>Monday</h2>
      </div>
    </header>

    <p v-if="loadError" style="color: var(--danger)">{{ loadError }}</p>

    <div class="monday-layout">
      <nav class="monday-boards-list card">
        <p v-if="loadingBoards">Carregando quadros...</p>
        <p v-else-if="workspaces.length === 0">Nenhum quadro ativo encontrado.</p>
        <div v-for="ws in workspaces" :key="ws.workspace.id" class="monday-workspace">
          <span class="eyebrow">{{ ws.workspace.name }}</span>
          <button
            v-for="board in ws.boards"
            :key="board.id"
            type="button"
            class="ghost monday-board-button"
            :class="{ active: selectedBoard?.id === board.id }"
            @click="selectBoard(board)"
          >
            {{ board.name }}
          </button>
        </div>
      </nav>

      <section class="monday-main card">
        <p v-if="!selectedBoard">Escolha um quadro à esquerda.</p>
        <p v-else-if="loadingBoardDetail">Carregando...</p>
        <p v-else-if="boardDetailError" style="color: var(--danger)">{{ boardDetailError }}</p>
        <div v-else-if="boardDetail" class="monday-board" :style="{ '--col-template': colTemplate }">
          <div class="monday-columns-header">
            <span></span>
            <span>Item</span>
            <span v-for="column in visibleColumns" :key="column.id">{{ column.title }}</span>
          </div>

          <div class="monday-groups-scroll">
            <div v-for="group in boardDetail.groups" :key="group.id" class="monday-group" :style="{ '--group-color': group.color || 'var(--accent-orange)' }">
              <div
                class="monday-group-header"
                role="button"
                tabindex="0"
                :aria-expanded="groupOf(group).expanded"
                @click="toggleGroup(group.id)"
                @keydown.enter.self.prevent="toggleGroup(group.id)"
                @keydown.space.self.prevent="toggleGroup(group.id)"
              >
                <span class="group-chevron" :class="{ collapsed: !groupOf(group).expanded }">▾</span>
                <span class="group-title">{{ group.title }}</span>
                <span class="group-count">{{ groupOf(group).items.length }}</span>
                <button type="button" class="ghost group-add-button" @click.stop="openCreatePanel(group.id)">+ Novo item</button>
              </div>

              <template v-if="groupOf(group).expanded">
                <p v-if="groupOf(group).error" style="color: var(--danger)">{{ groupOf(group).error }}</p>
                <p v-else-if="groupOf(group).loading && groupOf(group).items.length === 0" class="group-hint">Carregando itens...</p>
                <p v-else-if="groupOf(group).items.length === 0" class="group-hint">Nenhum item nesse grupo ainda.</p>

                <div
                  v-for="item in groupOf(group).items"
                  :key="item.id"
                  class="monday-row"
                  role="button"
                  tabindex="0"
                  @click="openEditPanel(item, group.id)"
                  @keydown.enter.self.prevent="openEditPanel(item, group.id)"
                  @keydown.space.self.prevent="openEditPanel(item, group.id)"
                >
                  <span class="row-accent"></span>
                  <span class="row-name">{{ item.name }}</span>
                  <span v-for="column in visibleColumns" :key="column.id" class="row-cell" @click="onCellClick($event, column, item, group.id)">
                    <MondayCell
                      :column="column"
                      :cv="columnValue(item, column.id)"
                      :users="users"
                      :item-id="item.id"
                      :board-id="selectedBoard!.id"
                      @updated="onCellUpdated(item, $event)"
                    />
                  </span>
                </div>

                <button type="button" class="add-item-row" @click="openCreatePanel(group.id)">+ Adicionar item</button>

                <button v-if="groupOf(group).cursor" type="button" class="ghost load-more-button" :disabled="groupOf(group).loading" @click="loadGroupItems(group.id, true)">
                  {{ groupOf(group).loading ? 'Carregando...' : 'Carregar mais' }}
                </button>
              </template>
            </div>

            <div class="input-prefix new-group-form">
              <input v-model="newGroupName" type="text" placeholder="+ Adicionar grupo" @keyup.enter="createGroup" />
              <button type="button" class="ghost" :disabled="creatingGroup || !newGroupName.trim()" @click="createGroup">+</button>
            </div>
            <p v-if="createGroupError" style="color: var(--danger)">{{ createGroupError }}</p>
          </div>
        </div>
      </section>
    </div>

    <MondayItemPanel
      v-if="panelMode && selectedBoard && boardDetail"
      :mode="panelMode"
      :board-id="selectedBoard.id"
      :columns="boardDetail.columns"
      :groups="boardDetail.groups"
      :default-group-id="activeGroupId"
      :item="panelItem ?? undefined"
      @close="closePanel"
      @saved="onPanelChanged"
      @deleted="onPanelChanged"
    />
  </div>
</template>

<style scoped>
.monday-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.monday-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  flex-shrink: 0;
}

.monday-layout {
  display: flex;
  gap: 16px;
  align-items: stretch;
  flex: 1;
  min-height: 0;
}

.monday-boards-list {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.monday-workspace {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.monday-board-button {
  text-align: left;
  padding: 8px 10px;
  font-size: 13px;
}

.monday-board-button.active {
  border-color: var(--accent-orange);
  color: var(--accent-orange);
}

.monday-main {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
}

.monday-main > p {
  padding: 20px;
}

.monday-board {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.monday-columns-header,
.monday-row,
.monday-group-header {
  display: grid;
  grid-template-columns: var(--col-template);
  align-items: center;
}

.monday-columns-header {
  gap: 8px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  position: sticky;
  top: 0;
  z-index: 1;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  flex-shrink: 0;
}

.monday-groups-scroll {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  padding: 12px 20px 20px;
}

.monday-group {
  border-left: 3px solid var(--group-color);
  border-radius: 4px;
  margin-bottom: 16px;
  background: var(--surface);
}

.monday-group-header {
  grid-template-columns: none !important;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  cursor: pointer;
}

.group-chevron {
  color: var(--group-color);
  font-size: 12px;
  transition: transform 0.15s ease;
}

.group-chevron.collapsed {
  transform: rotate(-90deg);
}

.group-title {
  color: var(--group-color);
  font-weight: 700;
  font-size: 14px;
}

.group-count {
  color: var(--text-secondary);
  font-size: 12px;
}

.group-add-button {
  margin-left: auto;
  font-size: 12px;
  padding: 6px 10px;
}

.group-hint {
  padding: 8px 14px 14px;
}

.monday-row {
  gap: 8px;
  padding: 6px 14px;
  cursor: pointer;
  border-top: 1px solid var(--border);
}

.monday-row:hover {
  background: var(--surface-hover);
}

.row-accent {
  width: 6px;
  height: 20px;
  border-radius: 3px;
  background: var(--group-color);
  opacity: 0.5;
}

.row-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-cell {
  min-width: 0;
}

.add-item-row {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-top: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  padding: 8px 14px;
}

.add-item-row:hover {
  background: var(--surface-hover);
  color: var(--accent-orange);
}

.load-more-button {
  margin: 8px 14px 12px;
  font-size: 12px;
  padding: 6px 10px;
}

.new-group-form {
  max-width: 220px;
}

@media (max-width: 900px) {
  .monday-view {
    height: auto;
  }

  .monday-header {
    flex-wrap: wrap;
    gap: 12px;
  }

  .monday-layout {
    flex-direction: column;
  }

  .monday-boards-list {
    width: auto;
    max-height: 240px;
  }

  .monday-main {
    flex: none;
  }

  /* Grade larga: rola na horizontal dentro do card, a página cuida da vertical. */
  .monday-board {
    overflow-x: auto;
  }

  .monday-columns-header,
  .monday-groups-scroll {
    min-width: max-content;
  }

  .monday-groups-scroll {
    overflow: visible;
  }
}
</style>
