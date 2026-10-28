<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, type MondayColumn, type MondayGroup, type MondayItem, type MondaySubitem, type MondayWorkspaceBoards } from '../api';
import { useModalDialog } from '../composables/useModalDialog';
import { useMondayUsers } from '../composables/useMondayUsers';
import SlackSendModal from './SlackSendModal.vue';
import { errorMessage, toggleInArray } from '../composables/utils';

const props = defineProps<{ open: boolean; title: string; tasks: string[]; promotionName: string }>();
const emit = defineEmits<{ close: []; sent: [] }>();

const BOARD_STORAGE_KEY = 'manual-review-monday-board';
const STEPS = ['Grupo', 'Elemento', 'Responsáveis', 'Atualização'] as const;

const dialog = ref<HTMLElement | null>(null);
useModalDialog(dialog, () => props.open);

const step = ref(0);
const error = ref('');
const loading = ref(false);
const sending = ref(false);
const sentUrl = ref<string | null | undefined>(undefined);

const workspaces = ref<MondayWorkspaceBoards[]>([]);
const boardId = ref('');
const groups = ref<MondayGroup[]>([]);
const groupId = ref('');
const boardColumns = ref<Record<string, MondayColumn[]>>({});
const assignColumnId = ref('');

const items = ref<MondayItem[]>([]);
const itemsCursor = ref<string | null>(null);
const itemFilter = ref('');
const itemId = ref('');
const NEW_ITEM = 'new';
const newItemName = ref('');
const subitems = ref<Record<string, MondaySubitem[]>>({});
const expandedItems = ref<string[]>([]);
const copied = ref(false);

const { users, ensureUsersLoaded } = useMondayUsers();
const userFilter = ref('');
const userIds = ref<string[]>([]);

const updateTitle = ref('');
const updateText = ref('');
const updateTasks = computed(() => updateText.value.split('\n').map((line) => line.trim()).filter(Boolean));
const slackOpen = ref(false);
const slackText = computed(() =>
  [`Ajuste(s) ${props.promotionName}`, ...(sentUrl.value ? ['', sentUrl.value] : [])].join('\n'),
);

const selectedGroup = computed(() => groups.value.find((group) => group.id === groupId.value));
const subitemParents = computed(() => {
  const parents = new Map<string, { parentId: string; subitem: MondaySubitem }>();
  for (const [parentId, list] of Object.entries(subitems.value)) {
    for (const subitem of list) parents.set(subitem.id, { parentId, subitem });
  }
  return parents;
});
const selectedSubitem = computed(() => subitemParents.value.get(itemId.value)?.subitem);
const selectedItemName = computed(() => {
  if (itemId.value === NEW_ITEM) return `${newItemName.value.trim()} (novo)`;
  const path: string[] = [];
  let id: string | undefined = itemId.value;
  while (id) {
    const entry = subitemParents.value.get(id);
    path.unshift(entry?.subitem.name ?? items.value.find((item) => item.id === id)?.name ?? '');
    id = entry?.parentId;
  }
  return path.join(' › ');
});
const itemRows = computed(() => {
  const rows: { entry: { id: string; name: string }; depth: number }[] = [];
  const visit = (entry: { id: string; name: string }, depth: number) => {
    rows.push({ entry, depth });
    if (expandedItems.value.includes(entry.id)) for (const child of subitems.value[entry.id] ?? []) visit(child, depth + 1);
  };
  for (const item of filteredItems.value) visit(item, 0);
  return rows;
});
const targetBoardId = computed(() => selectedSubitem.value?.boardId || boardId.value);
const peopleColumns = computed(() => (boardColumns.value[targetBoardId.value] ?? []).filter((column) => column.type === 'people' && column.editable));
const selectedUsers = computed(() => users.value.filter((user) => userIds.value.includes(user.id)));
const filteredItems = computed(() => filterByName(items.value, itemFilter.value));
const filteredUsers = computed(() => filterByName(users.value, userFilter.value));

const canAdvance = computed(() => [Boolean(groupId.value), Boolean(itemId.value) && (itemId.value !== NEW_ITEM || Boolean(newItemName.value.trim())), true, updateTasks.value.length > 0][step.value]);

function filterByName<T extends { name: string }>(list: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase('pt-BR');
  return needle ? list.filter((entry) => entry.name.toLocaleLowerCase('pt-BR').includes(needle)) : list;
}

async function guard(run: () => Promise<void>) {
  error.value = '';
  loading.value = true;
  try {
    await run();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    step.value = 0;
    sentUrl.value = undefined;
    itemId.value = '';
    itemFilter.value = '';
    newItemName.value = '';
    expandedItems.value = [];
    copied.value = false;
    slackOpen.value = false;
    userIds.value = [];
    userFilter.value = '';
    updateTitle.value = props.title;
    updateText.value = props.tasks.join('\n');
    guard(async () => {
      workspaces.value = await api.mondayBoards();
      let saved = '';
      try {
        saved = localStorage.getItem(BOARD_STORAGE_KEY) ?? '';
      } catch {}
      const boards = workspaces.value.flatMap((ws) => ws.boards);
      if (!boardId.value && boards.some((board) => board.id === saved)) boardId.value = saved;
      else if (boardId.value) await loadGroups();
    });
  },
);

watch(boardId, (id) => {
  try {
    localStorage.setItem(BOARD_STORAGE_KEY, id);
  } catch {}
  groupId.value = '';
  groups.value = [];
  if (id) guard(loadGroups);
});

watch(groupId, () => {
  itemId.value = '';
  items.value = [];
  itemsCursor.value = null;
  subitems.value = {};
  expandedItems.value = [];
});

async function loadGroups() {
  const id = boardId.value;
  const detail = await api.mondayBoardDetail(id);
  if (id !== boardId.value) return;
  groups.value = detail.groups;
  boardColumns.value = { ...boardColumns.value, [id]: detail.columns };
}

async function loadTargetColumns() {
  const id = targetBoardId.value;
  if (!boardColumns.value[id]) {
    const detail = await api.mondayBoardDetail(id);
    boardColumns.value = { ...boardColumns.value, [id]: detail.columns };
  }
  if (!peopleColumns.value.some((column) => column.id === assignColumnId.value)) {
    assignColumnId.value = peopleColumns.value.length === 1 ? peopleColumns.value[0]!.id : '';
  }
}

function toggleSubitems(parentId: string) {
  if (expandedItems.value.includes(parentId)) {
    expandedItems.value = expandedItems.value.filter((id) => id !== parentId);
    return;
  }
  expandedItems.value = [...expandedItems.value, parentId];
  if (!subitems.value[parentId]) {
    guard(async () => {
      const list = await api.mondaySubitems(parentId);
      subitems.value = { ...subitems.value, [parentId]: list };
    });
  }
}

async function copyLink() {
  if (!sentUrl.value) return;
  try {
    await navigator.clipboard.writeText(sentUrl.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    error.value = 'Não deu pra copiar o link.';
  }
}

async function loadItems(append: boolean) {
  const page = await api.mondayItems(boardId.value, groupId.value, append ? itemsCursor.value : null);
  items.value = append ? [...items.value, ...page.items] : page.items;
  itemsCursor.value = page.cursor;
}

function toggleUser(id: string) {
  userIds.value = toggleInArray(userIds.value, id);
}

function next() {
  if (!canAdvance.value) return;
  step.value += 1;
  if (step.value === 1) guard(() => loadItems(false));
  if (step.value === 2) guard(() => Promise.all([ensureUsersLoaded(), loadTargetColumns()]).then(() => {}));
}

async function send() {
  if (sending.value || !canAdvance.value) return;
  sending.value = true;
  error.value = '';
  try {
    if (itemId.value === NEW_ITEM) {
      const created = await api.mondayCreateItem(boardId.value, { name: newItemName.value.trim(), groupId: groupId.value });
      // Já criado: se a atualização falhar, repetir usa este elemento em vez de criar outro.
      items.value = [...items.value, { id: created.id, name: created.name, columnValues: [] }];
      itemId.value = created.id;
    }
    const result = await api.mondayPostChecklistUpdate(itemId.value, {
      boardId: targetBoardId.value,
      title: updateTitle.value.trim(),
      tasks: updateTasks.value,
      userIds: userIds.value,
      assignColumnId: userIds.value.length ? assignColumnId.value : '',
    });
    sentUrl.value = result.url;
    emit('sent');
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @keydown.esc="emit('close')">
    <div ref="dialog" class="card modal-card monday-send-card" role="dialog" aria-modal="true" aria-label="Enviar ao Monday">
      <h3>Enviar ao Monday</h3>

      <template v-if="sentUrl !== undefined">
        <p class="monday-send-success">Atualização criada com a lista de verificação.</p>
        <div v-if="sentUrl" class="monday-send-link">
          <a :href="sentUrl" target="_blank" rel="noopener noreferrer">{{ sentUrl }}</a>
          <button type="button" class="ghost" @click="copyLink">{{ copied ? 'Copiado' : 'Copiar link' }}</button>
        </div>
        <p v-if="error" style="color: var(--danger)">{{ error }}</p>
        <p v-else-if="!sentUrl" class="progress-caption">O Monday não devolveu o link do elemento.</p>
        <div class="card-footer">
          <button type="button" class="ghost" @click="slackOpen = true">Enviar ao Slack</button>
          <button type="button" class="primary" @click="emit('close')">Fechar</button>
        </div>
      </template>

      <template v-else>
        <ol class="monday-send-steps">
          <li v-for="(label, index) in STEPS" :key="label" :class="{ active: index === step, done: index < step }">
            <span>{{ index + 1 }}</span>{{ label }}
          </li>
        </ol>

        <div v-if="step === 0" class="monday-send-body">
          <div class="field">
            <label for="monday-send-board">Quadro</label>
            <select id="monday-send-board" v-model="boardId">
              <option value="" disabled>Escolha um quadro</option>
              <optgroup v-for="ws in workspaces" :key="ws.workspace.id" :label="ws.workspace.name">
                <option v-for="board in ws.boards" :key="board.id" :value="board.id">{{ board.name }}</option>
              </optgroup>
            </select>
          </div>
          <div v-if="groups.length" class="monday-send-options" role="radiogroup" aria-label="Grupo">
            <button
              v-for="group in groups"
              :key="group.id"
              type="button"
              role="radio"
              class="monday-send-option"
              :aria-checked="groupId === group.id"
              :style="group.color ? { '--group-color': group.color } : undefined"
              @click="groupId = group.id"
            >
              {{ group.title }}
            </button>
          </div>
        </div>

        <div v-else-if="step === 1" class="monday-send-body">
          <input v-model="itemFilter" type="search" placeholder="Filtrar elementos" aria-label="Filtrar elementos" />
          <div class="monday-send-options" role="radiogroup" aria-label="Elemento">
            <button
              type="button"
              role="radio"
              class="monday-send-option monday-send-new"
              :aria-checked="itemId === NEW_ITEM"
              @click="itemId = NEW_ITEM"
            >
              + Criar novo elemento
            </button>
            <input
              v-if="itemId === NEW_ITEM"
              v-model="newItemName"
              type="text"
              placeholder="Nome do novo elemento"
              aria-label="Nome do novo elemento"
              @keyup.enter="next"
            />
            <template v-for="{ entry, depth } in itemRows" :key="entry.id">
              <div class="monday-send-item" :style="{ marginLeft: `${depth * 24}px` }">
                <button
                  type="button"
                  role="radio"
                  class="monday-send-option"
                  :aria-checked="itemId === entry.id"
                  @click="itemId = entry.id"
                >
                  {{ entry.name }}
                </button>
                <button
                  type="button"
                  class="ghost monday-send-expand"
                  :aria-expanded="expandedItems.includes(entry.id)"
                  :aria-label="`Subelementos de ${entry.name}`"
                  @click="toggleSubitems(entry.id)"
                >
                  {{ expandedItems.includes(entry.id) ? '▾' : '▸' }} Subelementos
                </button>
              </div>
              <p
                v-if="expandedItems.includes(entry.id) && subitems[entry.id] && !subitems[entry.id]!.length"
                class="progress-caption"
                :style="{ marginLeft: `${(depth + 1) * 24}px` }"
              >
                Sem subelementos.
              </p>
            </template>
            <p v-if="!loading && !filteredItems.length && itemId !== NEW_ITEM" class="progress-caption">Nenhum elemento neste grupo.</p>
          </div>
          <button v-if="itemsCursor" type="button" class="ghost" :disabled="loading" @click="guard(() => loadItems(true))">Carregar mais</button>
        </div>

        <div v-else-if="step === 2" class="monday-send-body">
          <input v-model="userFilter" type="search" placeholder="Filtrar usuários" aria-label="Filtrar usuários" />
          <div class="monday-send-options" role="group" aria-label="Responsáveis">
            <button
              v-for="user in filteredUsers"
              :key="user.id"
              type="button"
              class="monday-send-option"
              :aria-pressed="userIds.includes(user.id)"
              @click="toggleUser(user.id)"
            >
              <img v-if="user.photo_thumb_small" :src="user.photo_thumb_small" alt="" />
              {{ user.name }}
            </button>
          </div>
          <div v-if="peopleColumns.length > 1" class="field">
            <label for="monday-send-assign-column">Atribuir na coluna</label>
            <select id="monday-send-assign-column" v-model="assignColumnId">
              <option value="">Não atribuir, só mencionar</option>
              <option v-for="column in peopleColumns" :key="column.id" :value="column.id">{{ column.title }}</option>
            </select>
          </div>
          <p class="progress-caption">
            <template v-if="assignColumnId">
              Opcional: quem for marcado é atribuído ao elemento na coluna
              "{{ peopleColumns.find((column) => column.id === assignColumnId)?.title }}", sem tirar quem já está lá.
            </template>
            <template v-else-if="peopleColumns.length">Opcional: quem for marcado só é mencionado na atualização.</template>
            <template v-else>Este quadro não tem coluna de pessoas: quem for marcado só é mencionado na atualização.</template>
          </p>
        </div>

        <div v-else class="monday-send-body">
          <dl class="monday-send-summary">
            <dt>Grupo</dt>
            <dd>{{ selectedGroup?.title }}</dd>
            <dt>Elemento</dt>
            <dd>{{ selectedItemName }}</dd>
            <dt>{{ assignColumnId ? 'Atribuir a' : 'Mencionar' }}</dt>
            <dd>{{ selectedUsers.map((user) => user.name).join(', ') || 'Ninguém' }}</dd>
          </dl>
          <div class="field">
            <label for="monday-send-title">Título</label>
            <input id="monday-send-title" v-model="updateTitle" type="text" />
          </div>
          <div class="field">
            <label for="monday-send-text">Lista de verificação (um item por linha)</label>
            <textarea id="monday-send-text" v-model="updateText" rows="10" />
          </div>
        </div>

        <p v-if="error" style="color: var(--danger)">{{ error }}</p>
        <p v-else-if="loading" class="progress-caption">Carregando...</p>

        <div class="card-footer">
          <button type="button" class="ghost" @click="step ? step-- : emit('close')">{{ step ? 'Voltar' : 'Cancelar' }}</button>
          <button v-if="step < STEPS.length - 1" type="button" class="primary" :disabled="!canAdvance || loading" @click="next">Avançar</button>
          <button v-else type="button" class="primary" :disabled="sending || !canAdvance" @click="send">{{ sending ? 'Criando...' : 'Criar atualização' }}</button>
        </div>
      </template>
    </div>
    <SlackSendModal :open="slackOpen" :text="slackText" @close="slackOpen = false" />
  </div>
</template>

<style scoped>
.monday-send-card {
  max-width: 560px;
}

.monday-send-steps {
  display: flex;
  gap: 8px;
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
  font-size: 12px;
  color: var(--text-secondary);
}

.monday-send-steps li {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  gap: 6px;
  padding-bottom: 6px;
  border-bottom: 2px solid var(--border);
}

.monday-send-steps li span {
  display: grid;
  place-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--surface-hover);
  font-weight: 700;
}

.monday-send-steps li.active {
  color: var(--text-primary);
  border-color: var(--accent-blue);
}

.monday-send-steps li.active span {
  background: var(--accent-blue);
  color: var(--bg);
}

.monday-send-steps li.done {
  border-color: var(--accent-green);
}

.monday-send-steps li.done span {
  background: var(--accent-green-soft);
  color: var(--accent-green);
}

.monday-send-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}

.monday-send-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
}

button.monday-send-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--group-color, var(--border));
  background: var(--surface-hover);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  text-align: left;
}

button.monday-send-option[aria-checked='true'],
button.monday-send-option[aria-pressed='true'] {
  border-color: var(--accent-blue);
  background: var(--accent-blue-soft);
}

button.monday-send-option.monday-send-new {
  border-style: dashed;
  color: var(--accent-blue);
}

.monday-send-item {
  display: flex;
  gap: 6px;
}

.monday-send-item .monday-send-option {
  flex: 1 1 auto;
}

button.monday-send-expand {
  flex: 0 0 auto;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary);
}

.monday-send-link {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.monday-send-link a {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-primary);
  font-size: 13px;
  word-break: break-all;
}

.monday-send-link button {
  flex: 0 0 auto;
}

button.monday-send-option img {
  width: 20px;
  height: 20px;
  border-radius: 50%;
}

.monday-send-summary {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 13px;
}

.monday-send-summary dt {
  color: var(--text-secondary);
}

.monday-send-summary dd {
  margin: 0;
}

#monday-send-text {
  resize: vertical;
  font-family: inherit;
}

.monday-send-success {
  color: var(--accent-green);
}
</style>
