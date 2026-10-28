<script setup lang="ts">
defineProps<{ id: string }>();

const TABS = [
  { env: 'dev', label: 'Dev' },
  { env: 'homolog', label: 'Homolog' },
  { env: 'producao', label: 'Produção' },
] as const;
</script>

<template>
  <nav class="tabs">
    <router-link
      v-for="tab in TABS"
      :key="tab.env"
      :to="`/promotions/${id}/${tab.env}`"
      class="tab"
      active-class="tab-active"
    >
      {{ tab.label }}
    </router-link>
  </nav>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 24px;
}

.tab {
  padding: 10px 16px;
  color: var(--text-secondary);
  text-decoration: none;
  font-weight: 600;
  border-bottom: 2px solid transparent;
}

.tab:hover {
  color: var(--text-primary);
}

.tab-active {
  color: var(--accent-orange);
  border-bottom-color: var(--accent-orange);
}
</style>
