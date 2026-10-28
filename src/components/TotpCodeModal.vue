<script setup lang="ts">
import { ref, watch } from 'vue';
import TotpCodeInput from './TotpCodeInput.vue';
import { useModalDialog } from '../composables/useModalDialog';

const props = withDefaults(
  defineProps<{ open: boolean; title?: string; description?: string; submitting?: boolean; error?: string }>(),
  {
    title: 'Token do autenticador',
    description: 'Digite o código atual do autenticador pra continuar.',
    submitting: false,
    error: '',
  },
);

const emit = defineEmits<{ confirm: [code: string]; cancel: [] }>();

const codeInput = ref('');
const localError = ref('');
const dialog = ref<HTMLElement | null>(null);
useModalDialog(dialog, () => props.open);

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      codeInput.value = '';
      localError.value = '';
    }
  },
);

function submit() {
  if (props.submitting) return;
  const code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    localError.value = 'Digite os 6 dígitos do token.';
    return;
  }
  localError.value = '';
  emit('confirm', code);
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @keydown.esc="emit('cancel')">
    <div ref="dialog" class="card modal-card totp-modal-card" role="dialog" aria-modal="true" :aria-label="title">
      <h3>{{ title }}</h3>
      <p>{{ description }}</p>
      <TotpCodeInput
        v-model="codeInput"
        paste-label="Colar e confirmar"
        :disabled="submitting"
        type="text"
        inputmode="numeric"
        maxlength="6"
        placeholder="000000"
        autofocus
        @keyup.enter="submit"
        @pasted="submit"
        @paste-error="localError = $event"
      />
      <p v-if="localError || error" style="color: var(--danger)">{{ localError || error }}</p>
      <p v-else-if="submitting" class="progress-caption">Autenticando...</p>
      <div class="card-footer">
        <button type="button" class="ghost" @click="emit('cancel')">Cancelar</button>
        <button type="button" class="primary" :disabled="submitting" @click="submit">
          {{ submitting ? 'Autenticando...' : 'Confirmar' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.totp-modal-card {
  max-width: 320px;
}

.totp-modal-card :deep(input) {
  width: 100%;
  font-size: 20px;
  letter-spacing: 6px;
  text-align: center;
}
</style>
