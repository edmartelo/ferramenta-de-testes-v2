<script setup lang="ts">
import { computed } from 'vue';
import type { TestGroupSummary } from '../api';

const props = defineProps<{
  groups: TestGroupSummary[];
  running: boolean;
  runningGroup?: string;
  disabled?: boolean;
  disabledReason?: string;
}>();
const emit = defineEmits<{ run: [groupId?: string]; stop: [] }>();

const hasAnyTest = computed(() => props.groups.some((group) => group.available));
const runAllDisabledReason = computed(() => {
  if (props.disabled) return props.disabledReason;
  if (!hasAnyTest.value) return 'Ainda não há testes cadastrados.';
  return undefined;
});

function title(group: TestGroupSummary): string {
  if (props.disabled) return props.disabledReason ?? '';
  if (!group.available) return `Nenhum teste de ${group.label} ainda.`;
  return `Rodar só: ${group.label}`;
}

function isStopButton(groupId: string): boolean {
  return props.running && props.runningGroup === groupId;
}

function click(groupId?: string): void {
  if (isStopButton(groupId ?? 'all')) emit('stop');
  else emit('run', groupId);
}
</script>

<template>
  <section class="button-group-panel">
    <span class="button-section-title">Testes</span>
    <div class="run-group-buttons">
      <button
        type="button"
        :class="isStopButton('all') ? 'stop-tests' : 'run-tests run-all'"
        :disabled="!isStopButton('all') && (props.running || Boolean(runAllDisabledReason))"
        :title="!props.running ? runAllDisabledReason : undefined"
        @click="click()"
      >
        {{ isStopButton('all') ? '■ Parar teste' : '▶ Rodar tudo' }}
      </button>

      <button
        v-for="group in props.groups"
        :key="group.id"
        type="button"
        :class="isStopButton(group.id) ? 'stop-tests run-group-button' : 'run-tests run-group-button'"
        :disabled="!isStopButton(group.id) && (props.running || props.disabled || !group.available)"
        :title="isStopButton(group.id) ? undefined : title(group)"
        @click="click(group.id)"
      >
        {{ isStopButton(group.id) ? '■ Parar teste' : `▶ ${group.label}` }}
      </button>
    </div>
    <p v-if="!props.running && runAllDisabledReason" class="run-disabled-reason">{{ runAllDisabledReason }}</p>
  </section>
</template>
