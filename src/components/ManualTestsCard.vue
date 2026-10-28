<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, type TestGroupSummary } from '../api';
import { errorMessage, toggleInArray } from '../composables/utils';

const props = defineProps<{ id: string; env: 'homolog' | 'producao'; groups: TestGroupSummary[]; checked: string[] }>();

const checked = ref<string[]>([]);
const error = ref('');
const saving = ref(false);

watch(() => props.checked, (value) => { checked.value = [...value]; }, { immediate: true });

const groupsWithManualTests = computed(() => props.groups.filter((group) => group.manualTests.length));

async function toggle(key: string): Promise<void> {
  if (saving.value) return;
  const previous = checked.value;
  checked.value = toggleInArray(previous, key);
  error.value = '';
  saving.value = true;
  const target = `${props.id}:${props.env}`;
  try {
    await api.saveManualTestChecks(props.id, props.env, checked.value);
  } catch (e) {
    if (target !== `${props.id}:${props.env}`) return;
    checked.value = previous;
    error.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section v-if="groupsWithManualTests.length" class="card manual-checklist-card">
    <h3>Testes manuais</h3>
    <div v-for="group in groupsWithManualTests" :key="group.id" class="manual-checklist-section">
      <h4>{{ group.label }}</h4>
      <ul class="manual-checklist-list">
        <li v-for="test in group.manualTests" :key="test.id">
          <label>
            <input
              type="checkbox"
              :checked="checked.includes(`${group.id}/${test.id}`)"
              :disabled="saving"
              @change="toggle(`${group.id}/${test.id}`)"
            />
            {{ test.label }}
          </label>
        </li>
      </ul>
    </div>
    <p v-if="error" style="color: var(--danger)">{{ error }}</p>
  </section>
</template>
