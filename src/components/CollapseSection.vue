<script setup lang="ts">
import { ref } from 'vue';
import NavIcon, { type NavIconName } from './NavIcon.vue';

const props = defineProps<{ title: string; defaultOpen?: boolean; icon?: NavIconName }>();
const open = ref(props.defaultOpen ?? false);
</script>

<template>
  <div class="collapse-section">
    <button type="button" class="collapse-trigger" :class="{ open }" @click="open = !open">
      <span class="collapse-title">
        <NavIcon v-if="icon" :name="icon" />
        {{ title }}
      </span>
      <svg class="chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 6 15 12 9 18" />
      </svg>
    </button>
    <div class="collapse-body" :class="{ open }">
      <div class="collapse-body-inner">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.collapse-section {
  width: 100%;
}

.collapse-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--text-primary);
  padding: 8px 4px;
  border-radius: 6px;
}

.collapse-trigger:hover {
  background: var(--surface-hover);
}

.collapse-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chevron {
  flex-shrink: 0;
  color: var(--text-secondary);
  transition: transform 0.2s ease;
}

.collapse-trigger.open .chevron {
  transform: rotate(90deg);
}

.collapse-body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.2s ease;
}

.collapse-body.open {
  grid-template-rows: 1fr;
}

.collapse-body-inner {
  overflow: hidden;
  padding-left: 12px;
}
</style>
