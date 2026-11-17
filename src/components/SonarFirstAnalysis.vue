<script setup lang="ts">
import { computed, ref } from 'vue';
import { EXAMPLE_FOLDERS, EXAMPLE_PROJECT_KEY, projectKeyProblem } from '../demo/sonar-browser';
import SonarScanCommand from './SonarScanCommand.vue';

const props = defineProps<{ idPrefix: string }>();

const projectKey = ref('');
const folder = ref('');

const keyProblem = computed(() => (projectKey.value ? projectKeyProblem(projectKey.value.trim()) : ''));
const commandKey = computed(() => (keyProblem.value ? '' : projectKey.value.trim()));
</script>

<template>
  <div class="first-analysis">
    <p>A análise lê a pasta do código e manda o resultado para o seu SonarQube. O projeto aparece lá sozinho na primeira análise.</p>
    <div class="first-analysis-fields">
      <div class="field">
        <label :for="`${props.idPrefix}-key`">Chave do projeto</label>
        <input
          :id="`${props.idPrefix}-key`"
          v-model="projectKey"
          autocomplete="off"
          spellcheck="false"
          :placeholder="EXAMPLE_PROJECT_KEY"
          :aria-invalid="Boolean(keyProblem)"
          :aria-describedby="`${props.idPrefix}-key-hint`"
        />
        <small :id="`${props.idPrefix}-key-hint`" class="field-hint" :class="{ 'first-analysis-error': keyProblem }" :role="keyProblem ? 'alert' : undefined">
          {{ keyProblem || 'Um nome curto e único, por exemplo o projeto e a parte: minha-promocao-backend.' }}
        </small>
      </div>
      <div class="field">
        <label :for="`${props.idPrefix}-folder`">Pasta do projeto</label>
        <input :id="`${props.idPrefix}-folder`" v-model="folder" autocomplete="off" spellcheck="false" :placeholder="EXAMPLE_FOLDERS.windows" />
        <small class="field-hint">O caminho completo da pasta com o código. O scanner só lê; não altera nada nela.</small>
      </div>
    </div>
    <SonarScanCommand :project-key="commandKey" :folder="folder" />
    <p class="field-hint">Requisitos: Docker Desktop aberto. Quando o comando terminar, clique em Atualizar na lista de projetos.</p>
  </div>
</template>

<style scoped>
.first-analysis-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 0 16px;
}

.first-analysis-error {
  color: var(--danger);
}
</style>
