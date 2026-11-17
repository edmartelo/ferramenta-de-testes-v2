<script setup lang="ts">
import { computed, ref } from 'vue';
import { scannerCommands, type ScannerOs } from '../demo/sonar-browser';
import SonarCopyBlock from './SonarCopyBlock.vue';

const props = defineProps<{ projectKey: string; folder?: string }>();

const OS_LABELS: Record<ScannerOs, string> = { windows: 'Windows (PowerShell)', unix: 'Linux ou Mac (terminal)' };

const os = ref<ScannerOs>(typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent) ? 'windows' : 'unix');
const commands = computed(() => scannerCommands(props.projectKey, props.folder ?? '', os.value));
</script>

<template>
  <div class="scan-command">
    <div class="scan-os" role="group" aria-label="Sistema da sua máquina">
      <button
        v-for="(label, key) in OS_LABELS"
        :key="key"
        type="button"
        class="scan-os-option"
        :class="{ active: os === key }"
        :aria-pressed="os === key"
        @click="os = key"
      >
        {{ label }}
      </button>
    </div>
    <p class="scan-step">1. No terminal, guarde o token numa variável (troque o texto entre aspas pelo seu token):</p>
    <SonarCopyBlock :code="commands.setToken" label="Comando que guarda o token no terminal" />
    <p class="scan-step">2. No mesmo terminal, rode a análise:</p>
    <SonarCopyBlock :code="commands.run" label="Comando do scanner do SonarQube" />
  </div>
</template>

<style scoped>
.scan-os {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}

.scan-os-option {
  padding: 8px 14px;
  background: transparent;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--text-secondary);
}

.scan-os-option:hover {
  color: var(--text-primary);
}

.scan-os-option.active {
  color: var(--accent-orange);
  border-bottom-color: var(--accent-orange);
}

.scan-os-option:focus-visible {
  outline: 2px solid var(--accent-orange);
  outline-offset: 2px;
}

.scan-step {
  margin: 12px 0 0;
}
</style>
