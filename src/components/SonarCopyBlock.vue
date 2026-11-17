<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ code: string; label: string }>();

const status = ref('');

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code);
    status.value = 'Copiado.';
  } catch {
    status.value = 'Não foi possível copiar: selecione o texto e copie manualmente.';
  }
}

watch(() => props.code, () => (status.value = ''));
</script>

<template>
  <div class="copy-block">
    <pre class="copy-block-code" tabindex="0" :aria-label="label">{{ code }}</pre>
    <div class="copy-block-actions">
      <button type="button" class="ghost" :aria-label="`Copiar: ${label}`" @click="copy">Copiar</button>
      <span role="status" class="field-hint">{{ status }}</span>
    </div>
  </div>
</template>

<style scoped>
.copy-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0;
}

.copy-block-code {
  margin: 0;
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.copy-block-code:focus-visible {
  outline: 2px solid var(--accent-orange);
  outline-offset: 2px;
}

.copy-block-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.copy-block-actions .field-hint {
  margin: 0;
}
</style>
