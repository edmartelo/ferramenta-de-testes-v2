<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TestResultRow, TestRunState } from '../composables/useTestRun';
import MondaySendModal from './MondaySendModal.vue';

const props = defineProps<{ run: TestRunState; updateTitle: string; promotionName: string }>();

const mondayModalOpen = ref(false);
const mondayQueue = computed(() => Object.keys(props.run.manualChecks).filter((itemId) => props.run.manualChecks[itemId] === 'queued'));

const sections = computed<{ label: string; items: TestResultRow[] }[]>(() =>
  [
    { label: 'Falharam', items: props.run.testResults.filter((item) => item.status === 'failed') },
    { label: 'N/A', items: props.run.testResults.filter((item) => item.status === 'not-applicable') },
  ].filter((section) => section.items.length),
);

const isDone = (itemId: string) => props.run.manualChecks[itemId] === 'done';
const isQueued = (itemId: string) => props.run.manualChecks[itemId] === 'queued';
const isSent = (itemId: string) => props.run.manualChecks[itemId] === 'sent';

const pendingCount = computed(() =>
  sections.value.reduce((total, section) => total + section.items.filter((item) => !props.run.manualChecks[item.itemId]).length, 0),
);

function onMondaySent() {
  props.run.setManualChecks(Object.fromEntries(mondayQueue.value.map((itemId) => [itemId, 'sent'])));
}

function toggleDone(itemId: string) {
  props.run.setManualChecks({ [itemId]: isDone(itemId) ? undefined : 'done' });
}

const mondayTasks = computed(() =>
  props.run.testResults
    .filter((item) => mondayQueue.value.includes(item.itemId))
    .map((item) => item.detail || item.title),
);

function toggleQueued(itemId: string) {
  props.run.setManualChecks({ [itemId]: isQueued(itemId) ? undefined : 'queued' });
}
</script>

<template>
  <section v-if="sections.length" class="card manual-checklist-card">
    <div class="manual-checklist-header">
      <h3>Conferência manual</h3>
      <button type="button" class="primary" :disabled="!mondayQueue.length" @click="mondayModalOpen = true">
        Enviar ao Monday ({{ mondayQueue.length }})
      </button>
    </div>
    <p class="progress-caption">
      Testes que falharam ou ficaram N/A nesta rodada: confira cada um no site e marque como concluído ou adicione à lista do Monday.
      {{ pendingCount ? `${pendingCount} pendente(s).` : 'Tudo conferido.' }}
    </p>
    <div v-for="section in sections" :key="section.label" class="manual-checklist-section">
      <h4>{{ section.label }}</h4>
      <ul class="manual-checklist-list">
        <li
          v-for="item in section.items"
          :key="item.itemId"
          class="manual-review-item"
          :class="{ done: isDone(item.itemId), queued: isQueued(item.itemId) || isSent(item.itemId) }"
        >
          <span class="manual-checklist-text">
            {{ item.title }}
            <small v-if="item.detail" class="test-detail" :class="item.status">{{ item.detail }}</small>
          </span>
          <div class="manual-checklist-actions">
            <button
              type="button"
              class="manual-action done"
              :aria-pressed="isDone(item.itemId)"
              @click="toggleDone(item.itemId)"
            >
              {{ isDone(item.itemId) ? 'Concluído' : 'Marcar concluído' }}
            </button>
            <button
              type="button"
              class="manual-action queued"
              :class="{ sent: isSent(item.itemId) }"
              :aria-pressed="isQueued(item.itemId) || isSent(item.itemId)"
              @click="toggleQueued(item.itemId)"
            >
              {{ isSent(item.itemId) ? 'Enviado ao Monday' : isQueued(item.itemId) ? 'Na lista do Monday' : 'Adicionar ao Monday' }}
            </button>
          </div>
        </li>
      </ul>
    </div>
    <MondaySendModal
      :open="mondayModalOpen"
      :title="updateTitle"
      :promotion-name="promotionName"
      :tasks="mondayTasks"
      @close="mondayModalOpen = false"
      @sent="onMondaySent"
    />
  </section>
</template>
