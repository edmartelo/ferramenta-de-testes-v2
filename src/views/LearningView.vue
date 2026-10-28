<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type LearningStatus, type Severity } from '../api';
import { authState } from '../auth-state';
import { useAsyncAction } from '../composables/useAsyncAction';
import { SEVERITY_LABELS } from '../composables/utils';

const status = ref<LearningStatus>();
const fileInput = ref<HTMLInputElement>();
const importResult = ref('');
const { error: loadError, run: runLoad } = useAsyncAction();
const { pending: exporting, error: exportError, run: runExport } = useAsyncAction();
const { pending: importing, error: importError, run: runImport } = useAsyncAction();

onMounted(() => runLoad(async () => {
  status.value = await api.getLearningStatus();
}));

function exportFile() {
  return runExport(async () => {
    const file = await api.exportLearning();
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `aprendizado-${file.exportedAt.slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  importResult.value = '';
  await runImport(async () => {
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new Error('O arquivo não é um JSON válido.');
    }
    const result = await api.importLearning(data);
    status.value = result.status;
    importResult.value = `${result.inserted} correção(ões) nova(s), ${result.updated} atualizada(s), ${result.unchanged} já estava(m) igual(is) ou mais recente(s) na base.`;
  });
}

const severities = Object.keys(SEVERITY_LABELS) as Severity[];
</script>

<template>
  <div>
    <span class="eyebrow">Configurações</span>
    <h1>Aprendizado</h1>
    <p>
      Correções de gravidade feitas em "Corrigir gravidade" no resumo dos atendimentos. Ficam no banco compartilhado. Exporte para guardar um backup; ao importar, a ferramenta aprende novas análises de níveis de criticidade.
    </p>

    <div class="card learning-card">
      <h3>Situação</h3>
      <p v-if="loadError" class="error">{{ loadError }}</p>
      <template v-else-if="status">
        <p>
          {{ status.total }} correção(ões)<template v-if="status.lastUpdatedAt">, a última em
          {{ new Date(status.lastUpdatedAt).toLocaleString('pt-BR') }}</template>.
        </p>
        <table class="learning-table">
          <tbody>
            <tr v-for="severity in severities" :key="severity">
              <td>{{ SEVERITY_LABELS[severity] }}</td>
              <td class="count">{{ status.bySeverity[severity] }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="status.trained.length > 0" class="hint">
          Classificador ativo: decide a gravidade para {{ status.trained.map((severity) => SEVERITY_LABELS[severity]).join(', ') }}.
        </p>
        <p v-else class="hint">
          Classificador aprendendo: decide a gravidade com {{ status.minLabels }} correções no total e
          {{ status.minPerSeverity }} em pelo menos 2 gravidades. Até lá, as correções servem de exemplo para o Ollama.
        </p>
      </template>
      <p v-else class="hint">Carregando...</p>
    </div>

    <div class="card learning-card">
      <h3>Arquivo de aprendizado</h3>
      <div class="actions">
        <button type="button" class="primary" :disabled="exporting" @click="exportFile">{{ exporting ? 'Exportando...' : 'Exportar' }}</button>
        <button v-if="authState.role === 'master'" type="button" class="ghost" :disabled="importing" @click="fileInput?.click()">{{ importing ? 'Importando...' : 'Importar' }}</button>
        <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="importFile" />
      </div>
      <p v-if="exportError" class="error">{{ exportError }}</p>
      <p v-if="importError" class="error">{{ importError }}</p>
      <p v-if="importResult" class="hint">{{ importResult }}</p>
    </div>
  </div>
</template>

<style scoped>
.learning-card {
  margin-top: 20px;
  max-width: 520px;
}

.learning-table {
  border-collapse: collapse;
  margin: 8px 0;
}

.learning-table td {
  padding: 4px 16px 4px 0;
}

.learning-table .count {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.actions {
  display: flex;
  gap: 8px;
}

.error {
  color: var(--danger);
}

.hint {
  color: var(--text-secondary);
}
</style>
