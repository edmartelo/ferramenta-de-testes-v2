<script setup lang="ts">
import { onMounted, ref } from 'vue';
import SonarProjectPanel from '../components/SonarProjectPanel.vue';
import { restoreSonarConnection, sonarConnection } from '../demo/sonar-browser';

defineProps<{ projectKey: string }>();

const restoring = ref(true);
const error = ref('');

onMounted(async () => {
  try {
    await restoreSonarConnection();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    restoring.value = false;
  }
});
</script>

<template>
  <div class="sonar-project-view">
    <header>
      <router-link to="/qualidade-codigo" class="back-link">← Qualidade de código</router-link>
      <span class="eyebrow">Testes</span>
    </header>

    <p v-if="restoring" role="status" class="progress-caption">Conectando ao SonarQube...</p>
    <template v-else-if="!sonarConnection.connected">
      <p v-if="error" role="alert" class="sonar-error">{{ error }}</p>
      <p>
        Conecte-se ao seu SonarQube para ver este projeto:
        <router-link to="/qualidade-codigo">abrir a conexão</router-link>.
      </p>
    </template>
    <SonarProjectPanel v-else :project-key="projectKey" />
  </div>
</template>

<style scoped>
.sonar-project-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1200px;
}

.sonar-error {
  color: var(--danger);
}

a:not(.back-link) {
  color: var(--accent-orange);
}
</style>
