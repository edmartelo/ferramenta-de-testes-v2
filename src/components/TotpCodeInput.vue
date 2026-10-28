<script setup lang="ts">
// Atributos do call site vão pro `<input>`, não pra div wrapper.
defineOptions({ inheritAttrs: false });
defineProps<{ pasteLabel: string; disabled?: boolean }>();
const emit = defineEmits<{ pasted: []; 'paste-error': [message: string] }>();
const code = defineModel<string>({ required: true });

async function paste() {
  try {
    const text = await navigator.clipboard.readText();
    code.value = text.replace(/\D/g, '').slice(0, 6);
  } catch {
    emit('paste-error', 'Não foi possível ler a área de transferência.');
    return;
  }
  emit('pasted');
}
</script>

<template>
  <div class="input-prefix">
    <input v-bind="$attrs" v-model="code" :disabled="disabled" />
    <button type="button" class="ghost input-icon-button" :title="pasteLabel" :aria-label="pasteLabel" :disabled="disabled" @click="paste">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      </svg>
    </button>
  </div>
</template>
