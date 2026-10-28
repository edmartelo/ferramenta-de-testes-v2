<script setup lang="ts">
import { ref, watch } from 'vue';
import type { MassRegistrationSummary } from '../api';

const props = defineProps<{
  groups: MassRegistrationSummary['groups'];
  limit: number;
  running: boolean;
  runningGroup?: string;
  disabled?: boolean;
  disabledReason?: string;
}>();
const emit = defineEmits<{ run: [groupId: string, quantity: number]; stop: [] }>();

const quantity = ref(1);

watch([quantity, () => props.limit], ([value]) => {
  const clamped = Math.min(props.limit, Math.max(1, Math.trunc(Number(value) || 1)));
  if (clamped !== value) quantity.value = clamped;
});

function isStopButton(groupId: string): boolean {
  return props.running && props.runningGroup === groupId;
}

function click(groupId: string): void {
  if (isStopButton(groupId)) emit('stop');
  else emit('run', groupId, quantity.value);
}
</script>

<template>
  <section class="button-group-panel">
    <span class="button-section-title">Cadastro de participante e cadastro de cupons</span>
    <div class="run-group-buttons">
      <label class="quantity-field" :title="`Máximo de ${props.limit} neste ambiente`">
        Quantidade
        <input v-model.number="quantity" type="number" min="1" :max="props.limit" step="1" :disabled="props.running" />
      </label>
      <button
        v-for="group in props.groups"
        :key="group.id"
        type="button"
        :class="isStopButton(group.id) ? 'stop-tests run-group-button' : 'run-mass run-group-button'"
        :disabled="!isStopButton(group.id) && (props.running || props.disabled)"
        :title="isStopButton(group.id) ? undefined : props.disabled ? props.disabledReason : `Cadastrar ${quantity}: ${group.label}`"
        @click="click(group.id)"
      >
        {{ isStopButton(group.id) ? '■ Parar' : `▶ ${group.label}` }}
      </button>
    </div>
  </section>
</template>
