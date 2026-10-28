<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api, type LogSource, type SlackDestinations } from '../api';
import { useModalDialog } from '../composables/useModalDialog';
import { errorMessage } from '../composables/utils';

const props = defineProps<{ open: boolean; text: string; logSource?: LogSource }>();
const emit = defineEmits<{ close: [] }>();

const DESTINATION_STORAGE_KEY = 'slack-send-destination';
const MENTIONS_STORAGE_KEY = 'slack-send-mentions';
const AUTO_CLOSE_MS = 1500;

const dialog = ref<HTMLElement | null>(null);
useModalDialog(dialog, () => props.open);

const destinations = ref<SlackDestinations>({ channels: [], users: [] });
const destination = ref('');
const filter = ref('');
const mentionIds = ref<string[]>([]);
const mentionFilter = ref('');
const message = ref('');
const loading = ref(false);
const sending = ref(false);
const error = ref('');
const sent = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | undefined;

const matches = (label: string, query: string) => label.toLocaleLowerCase('pt-BR').includes(query.trim().toLocaleLowerCase('pt-BR'));

const options = computed(() => {
  const all = [
    ...destinations.value.channels.map((channel) => ({ id: channel.id, label: `${channel.private ? '🔒' : '#'} ${channel.name}`, photo: undefined })),
    ...destinations.value.users.map((user) => ({ id: user.id, label: user.name, photo: user.photo })),
  ];
  return filter.value.trim() ? all.filter((option) => matches(option.label, filter.value) || option.id === destination.value) : all;
});
const mentionedUsers = computed(() => destinations.value.users.filter((user) => mentionIds.value.includes(user.id)));
const mentionOptions = computed(() =>
  mentionFilter.value.trim() ? destinations.value.users.filter((user) => !mentionIds.value.includes(user.id) && matches(user.name, mentionFilter.value)) : [],
);
const mentionPrefix = computed(() => mentionedUsers.value.map((user) => `@${user.name}`).join(' '));

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function close() {
  clearTimeout(closeTimer);
  emit('close');
}

onBeforeUnmount(() => clearTimeout(closeTimer));

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;
    message.value = props.text;
    filter.value = '';
    mentionFilter.value = '';
    error.value = '';
    sent.value = false;
    loading.value = true;
    try {
      destinations.value = await api.slackDestinations();
      const ids = [...destinations.value.channels, ...destinations.value.users].map((entry) => entry.id);
      const savedDestination = readStorage(DESTINATION_STORAGE_KEY);
      destination.value = ids.includes(destination.value) ? destination.value : ids.includes(savedDestination) ? savedDestination : '';
      const userIds = destinations.value.users.map((user) => user.id);
      mentionIds.value = readStorage(MENTIONS_STORAGE_KEY).split(',').filter((id) => userIds.includes(id));
    } catch (e) {
      error.value = errorMessage(e);
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

function addMention(id: string) {
  mentionIds.value = [...mentionIds.value, id];
  mentionFilter.value = '';
}

function removeMention(id: string) {
  mentionIds.value = mentionIds.value.filter((mentionId) => mentionId !== id);
}

async function send() {
  if (sending.value || !destination.value || !message.value.trim()) return;
  sending.value = true;
  error.value = '';
  const body = message.value.trim();
  const text = mentionIds.value.length ? `${mentionIds.value.map((id) => `<@${id}>`).join(' ')} - ${body}` : body;
  try {
    const destinationName = options.value.find((option) => option.id === destination.value)?.label;
    await api.slackSendMessage({ destination: destination.value, text, logSource: props.logSource, destinationName });
    writeStorage(DESTINATION_STORAGE_KEY, destination.value);
    writeStorage(MENTIONS_STORAGE_KEY, mentionIds.value.join(','));
    sent.value = true;
    closeTimer = setTimeout(close, AUTO_CLOSE_MS);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @keydown.esc.stop="close">
    <div ref="dialog" class="card modal-card slack-send-card" role="dialog" aria-modal="true" aria-label="Enviar ao Slack">
      <h3>Enviar ao Slack</h3>

      <p v-if="sent" class="slack-send-success" role="status">Mensagem enviada com sucesso.</p>

      <template v-else>
        <div class="slack-send-body">
          <div class="field">
            <label for="slack-send-filter">Enviar para</label>
            <input id="slack-send-filter" v-model="filter" type="search" placeholder="Filtrar canais e pessoas" />
          </div>
          <div class="slack-send-options" role="radiogroup" aria-label="Destinatário">
            <button
              v-for="option in options"
              :key="option.id"
              type="button"
              role="radio"
              class="slack-send-option"
              :aria-checked="destination === option.id"
              @click="destination = option.id"
            >
              <img v-if="option.photo" :src="option.photo" alt="" />
              {{ option.label }}
            </button>
            <p v-if="!loading && !options.length" class="progress-caption">Nenhum canal ou pessoa encontrado.</p>
          </div>

          <div class="field">
            <label for="slack-send-mention-filter">Mencionar</label>
            <div v-if="mentionedUsers.length" class="slack-send-chips">
              <button
                v-for="user in mentionedUsers"
                :key="user.id"
                type="button"
                class="slack-send-chip"
                :aria-label="`Remover menção a ${user.name}`"
                @click="removeMention(user.id)"
              >
                @{{ user.name }} ×
              </button>
            </div>
            <input id="slack-send-mention-filter" v-model="mentionFilter" type="search" placeholder="Digite um nome para mencionar" />
            <div v-if="mentionOptions.length" class="slack-send-options slack-send-mention-options">
              <button v-for="user in mentionOptions" :key="user.id" type="button" class="slack-send-option" @click="addMention(user.id)">
                <img v-if="user.photo" :src="user.photo" alt="" />
                {{ user.name }}
              </button>
            </div>
          </div>

          <div class="field">
            <label for="slack-send-text">Mensagem</label>
            <p v-if="mentionPrefix" class="progress-caption">Começa com: {{ mentionPrefix }} -</p>
            <textarea id="slack-send-text" v-model="message" rows="6" />
          </div>
        </div>

        <p v-if="error" style="color: var(--danger)">{{ error }}</p>
        <p v-else-if="loading" class="progress-caption">Carregando...</p>

        <div class="card-footer">
          <button type="button" class="ghost" @click="close">Cancelar</button>
          <button type="button" class="primary" :disabled="sending || loading || !destination || !message.trim()" @click="send">
            {{ sending ? 'Enviando...' : 'Enviar' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.slack-send-card {
  max-width: 560px;
}

.slack-send-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}

.slack-send-body .field {
  margin-bottom: 0;
}

.slack-send-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 200px;
  overflow-y: auto;
}

.slack-send-mention-options {
  margin-top: 6px;
  max-height: 160px;
}

button.slack-send-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  background: var(--surface-hover);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  text-align: left;
}

button.slack-send-option[aria-checked='true'] {
  border-color: var(--accent-blue);
  background: var(--accent-blue-soft);
}

button.slack-send-option img {
  width: 20px;
  height: 20px;
  border-radius: 50%;
}

.slack-send-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

button.slack-send-chip {
  padding: 4px 8px;
  border: 1px solid var(--accent-blue);
  border-radius: 12px;
  background: var(--accent-blue-soft);
  color: var(--text-primary);
  font-size: 12px;
}

#slack-send-text {
  resize: vertical;
  font-family: inherit;
}

.slack-send-success {
  color: var(--accent-green);
  font-weight: 500;
}
</style>
