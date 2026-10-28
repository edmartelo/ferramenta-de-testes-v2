<script setup lang="ts">
import { ref, watch } from 'vue';
import { useModalDialog } from '../composables/useModalDialog';

const props = defineProps<{ open: boolean; title: string; promotions: string[]; confirmLabel: string }>();
const emit = defineEmits<{ confirm: [selected: string[]]; cancel: [] }>();

const selected = ref<string[]>([]);
const dialog = ref<HTMLElement | null>(null);
useModalDialog(dialog, () => props.open);

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) selected.value = [...props.promotions];
  },
);

function toggleAll() {
  selected.value = selected.value.length === props.promotions.length ? [] : [...props.promotions];
}

function confirm() {
  if (selected.value.length === 0) return;
  emit('confirm', props.promotions.filter((name) => selected.value.includes(name)));
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @keydown.esc="emit('cancel')">
    <div ref="dialog" class="card modal-card picker-modal-card" role="dialog" aria-modal="true" :aria-label="title">
      <h3>{{ title }}</h3>
      <label class="picker-option picker-all">
        <input
          type="checkbox"
          :checked="selected.length === promotions.length"
          :indeterminate="selected.length > 0 && selected.length < promotions.length"
          @change="toggleAll"
        />
        Todas
      </label>
      <ul class="picker-list">
        <li v-for="name in promotions" :key="name">
          <label class="picker-option">
            <input v-model="selected" type="checkbox" :value="name" />
            {{ name }}
          </label>
        </li>
      </ul>
      <div class="card-footer">
        <button type="button" class="ghost" @click="emit('cancel')">Cancelar</button>
        <button type="button" class="primary" :disabled="selected.length === 0" @click="confirm">{{ confirmLabel }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker-modal-card {
  max-width: 420px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.picker-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
}

.picker-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  cursor: pointer;
}

.picker-option input {
  appearance: none;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin: 0;
  padding: 0;
  border: 1.5px solid var(--text-secondary);
  border-radius: 4px;
  background: transparent;
  display: grid;
  place-content: center;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.picker-option input::before {
  content: '';
  width: 10px;
  height: 10px;
  clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
  background: #1a1005;
  transform: scale(0);
  transition: transform 0.12s ease-out;
}

.picker-option input:checked,
.picker-option input:indeterminate {
  background: var(--accent-orange);
  border-color: var(--accent-orange);
}

.picker-option input:checked::before {
  transform: scale(1);
}

.picker-option input:indeterminate::before {
  height: 2px;
  clip-path: none;
  transform: scale(1);
}

.picker-option:hover input:not(:checked):not(:indeterminate) {
  border-color: var(--accent-orange);
}

.picker-option input:focus-visible {
  outline: 2px solid var(--accent-orange);
  outline-offset: 2px;
}

.picker-all {
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
  font-weight: 600;
}
</style>
