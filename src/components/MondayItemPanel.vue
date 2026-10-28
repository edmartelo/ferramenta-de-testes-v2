<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api, type MondayColumn, type MondayGroup, type MondayItem, type MondaySubitem, type MondayUpdate } from '../api';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useModalDialog } from '../composables/useModalDialog';
import { useMondayUsers } from '../composables/useMondayUsers';
import { toggleInArray } from '../composables/utils';
import ConfirmModal from './ConfirmModal.vue';

const props = defineProps<{
  mode: 'create' | 'edit';
  boardId: string;
  columns: MondayColumn[];
  groups: MondayGroup[];
  defaultGroupId?: string;
  item?: MondayItem;
}>();

const emit = defineEmits<{ close: []; saved: []; deleted: [] }>();

const editableColumns = props.columns.filter((c) => c.editable);

function defaultValueFor(type: string): unknown {
  if (type === 'checkbox') return false;
  if (type === 'dropdown' || type === 'people') return [];
  if (type === 'date' || type === 'link') return null;
  return '';
}

const name = ref(props.item?.name ?? '');
const groupId = ref(props.defaultGroupId ?? props.groups[0]?.id ?? '');
const formValues = reactive<Record<string, unknown>>({});
for (const column of editableColumns) {
  const existing = props.item?.columnValues.find((cv) => cv.columnId === column.id);
  formValues[column.id] = existing ? existing.value : defaultValueFor(column.type);
}

const { users, ensureUsersLoaded } = useMondayUsers();
if (editableColumns.some((c) => c.type === 'people')) ensureUsersLoaded();

function toggleListValue(columnId: string, value: string) {
  formValues[columnId] = toggleInArray((formValues[columnId] as string[]) ?? [], value);
}

function linkField(columnId: string, field: 'url' | 'text', value: string) {
  const current = (formValues[columnId] as { url: string; text: string } | null) ?? { url: '', text: '' };
  formValues[columnId] = { ...current, [field]: value };
}

function dateField(columnId: string, value: string) {
  formValues[columnId] = value ? { date: value } : null;
}

const { pending: saving, error: saveError, run } = useAsyncAction();

async function save() {
  if (!name.value.trim()) return;
  await run(async () => {
    if (props.mode === 'create') {
      await api.mondayCreateItem(props.boardId, { name: name.value.trim(), groupId: groupId.value || undefined, columnValues: { ...formValues } });
    } else {
      await api.mondayUpdateItem(props.item!.id, { boardId: props.boardId, name: name.value.trim(), columnValues: { ...formValues } });
    }
    emit('saved');
  });
}

const confirmingDelete = ref(false);
const { pending: deleting, error: deleteError, run: runDelete } = useAsyncAction();
async function confirmDelete() {
  if (await runDelete(() => api.mondayDeleteItem(props.item!.id))) emit('deleted');
}

const updates = ref<MondayUpdate[]>([]);
const newComment = ref('');
const { pending: updatesLoading, error: updatesError, run: runUpdates } = useAsyncAction();
const { pending: postingComment, error: commentError, run: runComment } = useAsyncAction();

async function loadUpdates() {
  if (props.mode !== 'edit') return;
  await runUpdates(async () => {
    updates.value = await api.mondayItemUpdates(props.item!.id);
  });
}

async function postComment() {
  if (!newComment.value.trim() || postingComment.value) return;
  const posted = await runComment(async () => {
    await api.mondayPostUpdate(props.item!.id, newComment.value.trim());
    newComment.value = '';
  });
  if (posted) await loadUpdates();
}

const subitems = ref<MondaySubitem[]>([]);
const newSubitemName = ref('');
const { pending: subitemsLoading, error: subitemsError, run: runSubitems } = useAsyncAction();
const { pending: changingSubitem, error: subitemActionError, run: runSubitemAction } = useAsyncAction();

async function loadSubitems() {
  if (props.mode !== 'edit') return;
  await runSubitems(async () => {
    subitems.value = await api.mondaySubitems(props.item!.id);
  });
}

async function addSubitem() {
  if (!newSubitemName.value.trim() || changingSubitem.value) return;
  const created = await runSubitemAction(async () => {
    await api.mondayCreateSubitem(props.item!.id, newSubitemName.value.trim());
    newSubitemName.value = '';
  });
  if (created) await loadSubitems();
}

const subitemToDelete = ref<MondaySubitem | null>(null);

async function confirmDeleteSubitem() {
  const subitem = subitemToDelete.value;
  if (!subitem || changingSubitem.value) return;
  if (await runSubitemAction(() => api.mondayDeleteItem(subitem.id))) {
    subitemToDelete.value = null;
    await loadSubitems();
  }
}

const editingSubitem = ref<MondaySubitem | null>(null);
const editingSubitemColumns = ref<MondayColumn[]>([]);
const editingSubitemItem = ref<MondayItem | null>(null);
const { pending: loadingSubitemDetail, error: subitemDetailError, run: runSubitemDetail } = useAsyncAction();

async function openSubitem(subitem: MondaySubitem) {
  await runSubitemDetail(async () => {
    const [detail, item] = await Promise.all([api.mondayBoardDetail(subitem.boardId), api.mondayItem(subitem.id, subitem.boardId)]);
    editingSubitemColumns.value = detail.columns;
    editingSubitemItem.value = item;
    editingSubitem.value = subitem;
  });
}

const dialog = ref<HTMLElement | null>(null);
useModalDialog(dialog);

function closeSubitemPanel() {
  editingSubitem.value = null;
  editingSubitemItem.value = null;
}

async function onSubitemChanged() {
  closeSubitemPanel();
  await loadSubitems();
}

onMounted(() => {
  loadUpdates();
  loadSubitems();
});

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR');
}
</script>

<template>
  <div class="modal-backdrop" @keydown.esc.stop="emit('close')">
    <div ref="dialog" class="card modal-card item-panel" role="dialog" aria-modal="true" :aria-label="mode === 'create' ? 'Novo item' : 'Editar item'">
      <h3>{{ mode === 'create' ? 'Novo item' : 'Editar item' }}</h3>

      <div class="field">
        <label>Nome</label>
        <input v-model="name" type="text" />
      </div>

      <div v-if="mode === 'create' && groups.length > 0" class="field">
        <label>Grupo</label>
        <select v-model="groupId">
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.title }}</option>
        </select>
      </div>

      <div v-for="column in editableColumns" :key="column.id" class="field">
        <label>{{ column.title }}</label>

        <input v-if="column.type === 'text' || column.type === 'numbers'" v-model="formValues[column.id] as string" :type="column.type === 'numbers' ? 'number' : 'text'" />

        <textarea v-else-if="column.type === 'long_text'" v-model="formValues[column.id] as string" rows="3" />

        <select v-else-if="column.type === 'status'" v-model="formValues[column.id] as string">
          <option value="">—</option>
          <option v-for="opt in column.options" :key="opt.id" :value="opt.label">{{ opt.label }}</option>
        </select>

        <div v-else-if="column.type === 'dropdown'" class="chip-picker">
          <label v-for="opt in column.options" :key="opt.id" class="radio-option">
            <input type="checkbox" :checked="((formValues[column.id] as string[]) ?? []).includes(opt.label)" @change="toggleListValue(column.id, opt.label)" />
            {{ opt.label }}
          </label>
        </div>

        <input v-else-if="column.type === 'date'" type="date" :value="(formValues[column.id] as { date: string } | null)?.date ?? ''" @input="dateField(column.id, ($event.target as HTMLInputElement).value)" />

        <div v-else-if="column.type === 'people'" class="chip-picker">
          <label v-for="user in users" :key="user.id" class="radio-option">
            <input type="checkbox" :checked="((formValues[column.id] as string[]) ?? []).includes(user.id)" @change="toggleListValue(column.id, user.id)" />
            {{ user.name }}
          </label>
        </div>

        <label v-else-if="column.type === 'checkbox'" class="radio-option">
          <input type="checkbox" v-model="formValues[column.id] as boolean" />
          Marcado
        </label>

        <div v-else-if="column.type === 'link'" class="input-prefix">
          <input type="text" placeholder="URL" :value="(formValues[column.id] as { url: string } | null)?.url ?? ''" @input="linkField(column.id, 'url', ($event.target as HTMLInputElement).value)" />
          <input type="text" placeholder="Texto do link" :value="(formValues[column.id] as { text: string } | null)?.text ?? ''" @input="linkField(column.id, 'text', ($event.target as HTMLInputElement).value)" />
        </div>
      </div>

      <p v-if="saveError" style="color: var(--danger)">{{ saveError }}</p>

      <div v-if="mode === 'edit'" class="updates-section">
        <span class="eyebrow">Subitens</span>
        <p v-if="subitemsLoading">Carregando...</p>
        <ul v-else-if="subitems.length > 0" class="subitems-list">
          <li v-for="s in subitems" :key="s.id">
            <button type="button" class="subitem-name" @click="openSubitem(s)">{{ s.name }}</button>
            <button type="button" class="subitem-remove" title="Excluir subitem" :aria-label="`Excluir subitem ${s.name}`" :disabled="changingSubitem" @click="subitemActionError = ''; subitemToDelete = s">×</button>
          </li>
        </ul>
        <p v-else-if="!subitemsError">Nenhum subitem ainda.</p>
        <p v-if="subitemsError || subitemActionError || subitemDetailError" style="color: var(--danger)">
          {{ subitemsError || subitemActionError || subitemDetailError }}
        </p>
        <div class="input-prefix">
          <input v-model="newSubitemName" type="text" placeholder="Novo subitem..." @keyup.enter="addSubitem" />
          <button type="button" class="ghost" :disabled="changingSubitem || !newSubitemName.trim()" @click="addSubitem">+</button>
        </div>
      </div>

      <div v-if="mode === 'edit'" class="updates-section">
        <span class="eyebrow">Comentários</span>
        <p v-if="updatesLoading">Carregando...</p>
        <ul v-else-if="updates.length > 0" class="updates-list">
          <li v-for="u in updates" :key="u.id">
            <strong>{{ u.creator?.name ?? 'Alguém' }}</strong>
            <span class="update-date">{{ formatDate(u.created_at) }}</span>
            <p>{{ u.text_body }}</p>
          </li>
        </ul>
        <p v-else-if="!updatesError">Nenhum comentário ainda.</p>
        <p v-if="updatesError || commentError" style="color: var(--danger)">{{ updatesError || commentError }}</p>
        <div class="input-prefix">
          <input v-model="newComment" type="text" placeholder="Escrever um comentário..." @keyup.enter="postComment" />
          <button type="button" class="ghost" :disabled="postingComment || !newComment.trim()" @click="postComment">Enviar</button>
        </div>
      </div>

      <p v-if="deleteError" style="color: var(--danger)">{{ deleteError }}</p>
      <div class="card-footer">
        <button v-if="mode === 'edit' && !confirmingDelete" type="button" class="danger" @click="confirmingDelete = true">Excluir item</button>
        <template v-if="mode === 'edit' && confirmingDelete">
          <span>Confirma exclusão?</span>
          <button type="button" class="ghost" @click="confirmingDelete = false">Cancelar</button>
          <button type="button" class="danger" :disabled="deleting" @click="confirmDelete">{{ deleting ? 'Excluindo...' : 'Sim, excluir' }}</button>
        </template>
        <div v-if="mode === 'create' || !confirmingDelete" class="spacer-actions">
          <button type="button" class="ghost" @click="emit('close')">Fechar</button>
          <button type="button" class="primary" :disabled="saving || !name.trim()" @click="save">
            {{ saving ? 'Salvando...' : 'Salvar' }}
          </button>
        </div>
      </div>
    </div>

    <MondayItemPanel
      v-if="editingSubitem"
      mode="edit"
      :board-id="editingSubitem.boardId"
      :columns="editingSubitemColumns"
      :groups="[]"
      :item="editingSubitemItem ?? undefined"
      @close="closeSubitemPanel"
      @saved="onSubitemChanged"
      @deleted="onSubitemChanged"
    />
    <p v-if="loadingSubitemDetail" class="loading-overlay-hint">Carregando subitem...</p>
    <ConfirmModal
      :open="Boolean(subitemToDelete)"
      title="Excluir subitem?"
      :description="`O subitem ${subitemToDelete?.name} é apagado no Monday. Não tem como desfazer.`"
      :confirm-label="changingSubitem ? 'Excluindo...' : 'Excluir'"
      cancel-label="Cancelar"
      variant="danger"
      :pending="changingSubitem"
      :error="subitemActionError"
      @confirm="confirmDeleteSubitem"
      @cancel="subitemToDelete = null"
    />
  </div>
</template>

<style scoped>
.item-panel {
  max-width: 640px;
  width: 90vw;
  max-height: 90vh;
  overflow-y: auto;
}

.subitems-list {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.subitems-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--surface-hover);
  border-radius: 6px;
  padding: 2px 4px 2px 10px;
}

.subitem-name {
  background: transparent;
  border: none;
  color: var(--accent-orange);
  text-align: left;
  flex: 1;
  padding: 6px 0;
  font-weight: 500;
  font-size: 13px;
}

.subitem-remove {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  padding: 4px 8px;
  font-size: 14px;
}

.subitem-remove:hover {
  color: var(--danger);
}

.loading-overlay-hint {
  position: fixed;
  bottom: 16px;
  right: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  z-index: 200;
}

.chip-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.updates-section {
  margin: 16px 0;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.updates-list {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 160px;
  overflow-y: auto;
}

.updates-list li {
  background: var(--surface-hover);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
}

.updates-list p {
  margin: 4px 0 0;
  color: var(--text-primary);
}

.update-date {
  color: var(--text-secondary);
  font-size: 11px;
  margin-left: 8px;
}

.card-footer {
  flex-wrap: wrap;
  gap: 8px;
}

.spacer-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
</style>
