<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { api } from '../api';
import type { MondayColumn, MondayItemColumnValue, MondayUser } from '../api';
import { useAsyncAction } from '../composables/useAsyncAction';
import { safeHttpUrl, toggleInArray } from '../composables/utils';

const props = defineProps<{
  column: MondayColumn;
  cv?: MondayItemColumnValue;
  users: MondayUser[];
  itemId: string;
  boardId: string;
}>();

const emit = defineEmits<{ updated: [cv: MondayItemColumnValue] }>();

const POPOVER_TYPES = ['status', 'dropdown', 'people', 'link'];

const statusOption = computed(() => {
  if (props.column.type !== 'status') return undefined;
  const label = (props.cv?.value as string | undefined) ?? props.cv?.text ?? undefined;
  return props.column.options?.find((o) => o.label === label);
});

const dropdownLabels = computed(() => (Array.isArray(props.cv?.value) ? (props.cv!.value as string[]) : []));

const peopleIds = computed(() => (Array.isArray(props.cv?.value) ? (props.cv!.value as (string | number)[]).map(String) : []));
const peopleUsers = computed(() => peopleIds.value.map((id) => props.users.find((u) => u.id === id)).filter((u): u is MondayUser => Boolean(u)));

const linkValue = computed(() => props.cv?.value as { url: string; text?: string } | null | undefined);
const linkHref = computed(() => safeHttpUrl(linkValue.value?.url));
const interactive = computed(() => props.column.editable || props.column.type === 'subtasks');

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

const editing = ref(false);
const { pending: saving, error: saveError, run } = useAsyncAction();

const cellRoot = ref<HTMLElement | null>(null);
const popoverEl = ref<HTMLElement | null>(null);
const popoverStyle = ref<Record<string, string>>({});

/** `v-model` num `<input type="number">` devolve número. */
const draftText = ref<string | number>('');
const draftDate = ref('');
const draftUrl = ref('');
const draftLinkText = ref('');

function outsideClick(e: MouseEvent) {
  if (popoverEl.value && !popoverEl.value.contains(e.target as Node)) closeEditing();
}

function addOutsideListener() {
  window.addEventListener('mousedown', outsideClick, true);
}

function removeOutsideListener() {
  window.removeEventListener('mousedown', outsideClick, true);
}

onBeforeUnmount(removeOutsideListener);

function closeEditing() {
  editing.value = false;
  saveError.value = '';
  removeOutsideListener();
}

// `position: fixed`: o `overflow` do scroll da grade cortaria um popover absoluto.
function positionPopover() {
  const rect = cellRoot.value?.getBoundingClientRect();
  if (!rect) return;
  const style: Record<string, string> = { position: 'fixed', top: `${rect.bottom + 4}px`, zIndex: '300' };
  if (rect.left + 220 > window.innerWidth) style.right = `${window.innerWidth - rect.right}px`;
  else style.left = `${rect.left}px`;
  popoverStyle.value = style;
}

async function save(rawValue: unknown, buildCv: () => MondayItemColumnValue) {
  await run(async () => {
    await api.mondayUpdateItem(props.itemId, { boardId: props.boardId, columnValues: { [props.column.id]: rawValue } });
    emit('updated', buildCv());
    closeEditing();
  });
}

function startEditing() {
  if (!props.column.editable || saving.value) return;
  saveError.value = '';

  if (props.column.type === 'checkbox') {
    const next = !(props.cv?.value === true);
    save(next, () => ({ columnId: props.column.id, text: next ? 'v' : '', value: next }));
    return;
  }

  if (props.column.type === 'text' || props.column.type === 'long_text' || props.column.type === 'numbers') {
    draftText.value = (props.cv?.value as string | undefined) ?? props.cv?.text ?? '';
  } else if (props.column.type === 'date') {
    draftDate.value = (props.cv?.value as { date: string } | null | undefined)?.date ?? '';
  } else if (props.column.type === 'link') {
    draftUrl.value = linkValue.value?.url ?? '';
    draftLinkText.value = linkValue.value?.text ?? '';
  }

  editing.value = true;
  if (POPOVER_TYPES.includes(props.column.type)) {
    nextTick(() => {
      positionPopover();
      addOutsideListener();
    });
  } else {
    nextTick(() => {
      const input = cellRoot.value?.querySelector('input, textarea') as HTMLInputElement | null;
      input?.focus();
      input?.select?.();
    });
  }
}

function saveText() {
  if (!editing.value || saving.value) return; // Enter já salvou (ou está salvando) antes do blur
  const value = String(draftText.value).trim();
  save(value, () => ({ columnId: props.column.id, text: value, value }));
}

function saveDate() {
  if (!draftDate.value) {
    save(null, () => ({ columnId: props.column.id, text: '', value: null }));
    return;
  }
  const date = draftDate.value;
  save({ date }, () => ({ columnId: props.column.id, text: date, value: { date } }));
}

function selectStatus(label: string) {
  save(label, () => ({ columnId: props.column.id, text: label, value: label }));
}

function toggleDropdownLabel(label: string) {
  const next = toggleInArray(dropdownLabels.value, label);
  save(next, () => ({ columnId: props.column.id, text: next.join(', '), value: next }));
}

function togglePerson(userId: string) {
  const next = toggleInArray(peopleIds.value, userId);
  const names = next
    .map((id) => props.users.find((u) => u.id === id)?.name)
    .filter((name): name is string => Boolean(name))
    .join(', ');
  save(next, () => ({ columnId: props.column.id, text: names, value: next }));
}

function saveLink() {
  const url = draftUrl.value.trim();
  if (!url) {
    save(null, () => ({ columnId: props.column.id, text: '', value: null }));
    return;
  }
  const value = { url, text: draftLinkText.value.trim() };
  save(value, () => ({ columnId: props.column.id, text: value.text || value.url, value }));
}

function onTextKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && props.column.type !== 'long_text') {
    e.preventDefault();
    saveText();
  } else if (e.key === 'Escape') {
    closeEditing();
  }
}
</script>

<template>
  <div
    ref="cellRoot"
    class="cell-root"
    :class="{ editable: column.editable, clickable: column.type === 'subtasks' }"
    :role="interactive && !editing ? 'button' : undefined"
    :tabindex="interactive && !editing ? 0 : undefined"
    @click="!editing && startEditing()"
    @keydown.enter.self.prevent="($event.currentTarget as HTMLElement).click()"
    @keydown.space.self.prevent="($event.currentTarget as HTMLElement).click()"
  >
    <template v-if="!editing || POPOVER_TYPES.includes(column.type)">
      <span v-if="column.type === 'status'" class="status-pill" :style="{ background: statusOption?.color || 'var(--surface-hover)' }">
        {{ cv?.text || '—' }}
      </span>

      <span v-else-if="column.type === 'checkbox'" class="checkbox-cell" :class="{ checked: cv?.value === true }">
        <span v-if="cv?.value === true">✓</span>
      </span>

      <div v-else-if="column.type === 'people'" class="people-cell">
        <span v-if="peopleUsers.length === 0" class="cell-chevron">▾</span>
        <span v-for="u in peopleUsers.slice(0, 3)" :key="u.id" class="avatar" :title="u.name">
          <img v-if="u.photo_thumb_small" :src="u.photo_thumb_small" :alt="u.name" />
          <template v-else>{{ initials(u.name) }}</template>
        </span>
        <span v-if="peopleUsers.length > 3" class="avatar avatar-more">+{{ peopleUsers.length - 3 }}</span>
      </div>

      <div v-else-if="column.type === 'dropdown'" class="chip-row">
        <span v-if="dropdownLabels.length === 0" class="cell-empty">—</span>
        <span v-for="label in dropdownLabels" :key="label" class="cell-chip">{{ label }}</span>
      </div>

      <a v-else-if="column.type === 'link' && linkHref" class="cell-link" :href="linkHref" target="_blank" rel="noopener" @click.stop>
        {{ linkValue?.text || linkHref }}
      </a>
      <span v-else-if="column.type === 'link' && linkValue?.url" class="cell-text">{{ linkValue.text || linkValue.url }}</span>
      <span v-else-if="column.type === 'link'" class="cell-empty">—</span>

      <span v-else-if="column.type === 'numbers'" class="cell-number">{{ cv?.text || '—' }}</span>

      <span v-else-if="column.type === 'subtasks'" class="cell-chevron">▾</span>

      <span v-else class="cell-text">{{ cv?.text || '—' }}</span>
    </template>

    <template v-else>
      <input
        v-if="column.type === 'text' || column.type === 'numbers'"
        v-model="draftText"
        class="cell-input"
        :type="column.type === 'numbers' ? 'number' : 'text'"
        @blur="saveText"
        @keydown="onTextKeydown"
      />
      <textarea v-else-if="column.type === 'long_text'" v-model="draftText" class="cell-input cell-textarea" rows="2" @blur="saveText" @keydown.esc="closeEditing" />
      <input v-else-if="column.type === 'date'" v-model="draftDate" type="date" class="cell-input" @change="saveDate" @keydown.esc="closeEditing" />
    </template>

    <Teleport to="body">
      <div
        v-if="editing && POPOVER_TYPES.includes(column.type)"
        ref="popoverEl"
        class="cell-popover"
        :class="{ saving, wide: column.type === 'people' || column.type === 'dropdown' }"
        :style="popoverStyle"
        @click.stop
        @keydown.esc="closeEditing"
      >
        <template v-if="column.type === 'status'">
          <button
            v-for="opt in column.options"
            :key="opt.id"
            type="button"
            class="popover-option"
            :class="{ active: opt.label === cv?.text }"
            :disabled="saving"
            @click="selectStatus(opt.label)"
          >
            <span class="popover-dot" :style="{ background: opt.color || 'var(--surface-hover)' }"></span>
            {{ opt.label }}
          </button>
        </template>

        <template v-else-if="column.type === 'dropdown'">
          <label v-for="opt in column.options" :key="opt.id" class="popover-checkbox">
            <input type="checkbox" :disabled="saving" :checked="dropdownLabels.includes(opt.label)" @change="toggleDropdownLabel(opt.label)" />
            <span class="popover-checkbox-label">{{ opt.label }}</span>
          </label>
        </template>

        <template v-else-if="column.type === 'people'">
          <label v-for="u in users" :key="u.id" class="popover-checkbox">
            <input type="checkbox" :disabled="saving" :checked="peopleIds.includes(u.id)" @change="togglePerson(u.id)" />
            <span class="popover-checkbox-label" :title="u.name">{{ u.name }}</span>
          </label>
        </template>

        <template v-else-if="column.type === 'link'">
          <input v-model="draftUrl" type="text" class="cell-input" placeholder="URL" @keydown.enter="saveLink" @keydown.esc="closeEditing" />
          <input v-model="draftLinkText" type="text" class="cell-input" placeholder="Texto do link" @keydown.enter="saveLink" @keydown.esc="closeEditing" />
          <button type="button" class="primary popover-confirm" :disabled="saving" @click="saveLink">Salvar</button>
        </template>

        <p v-if="saveError" class="popover-error">{{ saveError }}</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.cell-root {
  width: 100%;
  min-width: 0;
}

.cell-root.editable,
.cell-root.clickable {
  cursor: pointer;
  border-radius: 4px;
}

.cell-root.editable:hover,
.cell-root.clickable:hover {
  background: var(--surface-hover);
}

.cell-input {
  width: 100%;
  font-size: 13px;
  padding: 4px 6px;
}

.cell-textarea {
  resize: vertical;
}

.cell-empty {
  color: var(--text-secondary);
}

.cell-chevron {
  display: inline-block;
  color: var(--text-secondary);
  font-size: 25px;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  width: 100%;
  padding: 0 10px;
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  text-align: center;
}

.checkbox-cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  border: 1px solid var(--border);
  color: var(--accent-green);
  font-weight: 700;
}

.checkbox-cell.checked {
  background: var(--accent-green-soft);
  border-color: var(--accent-green);
}

.people-cell {
  display: flex;
  align-items: center;
  gap: 4px;
}

.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--accent-orange-soft);
  color: var(--accent-orange);
  font-size: 10px;
  font-weight: 700;
  overflow: hidden;
  flex-shrink: 0;
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.avatar-more {
  background: var(--surface-hover);
  color: var(--text-secondary);
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.cell-chip {
  color: var(--text-secondary);
  font-size: 12px;
  background: var(--surface-hover);
  border-radius: 4px;
  padding: 2px 6px;
  white-space: nowrap;
}

.cell-link {
  color: var(--accent-orange);
  font-size: 13px;
  text-decoration: none;
}

.cell-link:hover {
  text-decoration: underline;
}

.cell-number {
  display: block;
  text-align: right;
  font-size: 13px;
  color: var(--text-primary);
}

.cell-text {
  font-size: 13px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-popover {
  min-width: 200px;
  max-width: 260px;
  max-height: 260px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-popover.saving {
  opacity: 0.7;
  pointer-events: none;
}

.cell-popover.wide {
  min-width: 240px;
  max-width: 320px;
}

.popover-option {
  display: flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: none;
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 13px;
  color: var(--text-primary);
  text-align: left;
}

.popover-option:hover,
.popover-option.active {
  background: var(--surface-hover);
}

.popover-dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}

.popover-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  font-size: 13px;
  border-radius: 4px;
}

.popover-checkbox:hover {
  background: var(--surface-hover);
}

.popover-checkbox input[type='checkbox'] {
  flex-shrink: 0;
}

.popover-checkbox-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.popover-confirm {
  margin-top: 4px;
}

.popover-error {
  color: var(--danger);
  font-size: 12px;
  margin: 4px 2px 0;
}
</style>
