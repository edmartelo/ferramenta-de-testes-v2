<script setup lang="ts">
import { ref } from 'vue';
import { useModalDialog } from '../composables/useModalDialog';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'primary' | 'danger';
    pending?: boolean;
    error?: string;
  }>(),
  { confirmLabel: 'Sim', cancelLabel: 'Não', variant: 'primary', pending: false, error: '' },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const dialog = ref<HTMLElement | null>(null);
useModalDialog(dialog, () => props.open);

function cancel() {
  if (!props.pending) emit('cancel');
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @keydown.esc.stop="cancel">
    <div ref="dialog" class="card modal-card confirm-modal-card" role="alertdialog" aria-modal="true" :aria-label="title">
      <h3>{{ title }}</h3>
      <p>{{ description }}</p>
      <p v-if="error" role="alert" style="color: var(--danger)">{{ error }}</p>
      <div class="card-footer">
        <button type="button" class="ghost" :disabled="pending" @click="cancel">{{ cancelLabel }}</button>
        <button type="button" :class="variant" :disabled="pending" @click="emit('confirm')">{{ confirmLabel }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm-modal-card {
  max-width: 420px;
}
</style>
