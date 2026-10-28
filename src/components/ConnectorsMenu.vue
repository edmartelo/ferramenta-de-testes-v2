<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import PasswordField from './PasswordField.vue';
import { api } from '../api';
import { useAsyncAction } from '../composables/useAsyncAction';

const mondayConnected = ref(false);
const mondayError = ref('');
const { pending: disconnecting, error: mondayDisconnectError, run: runMondayDisconnect } = useAsyncAction();

const promoMonitorConnected = ref(false);
const promoMonitorEmail = ref('');
const promoMonitorFormOpen = ref(false);
const promoMonitorForm = reactive({ email: '', password: '', totpSecret: '' });
const { pending: promoMonitorSaving, error: promoMonitorError, run: runPromoMonitorSave } = useAsyncAction();
const { pending: promoMonitorDisconnecting, error: promoMonitorDisconnectError, run: runPromoMonitorDisconnect } = useAsyncAction();
const { error: statusError, run: runStatus } = useAsyncAction();

const slackConnected = ref(false);
const slackTeamName = ref('');
const slackError = ref('');
const { pending: slackDisconnecting, error: slackDisconnectError, run: runSlackDisconnect } = useAsyncAction();

function refreshStatus() {
  return runStatus(async () => {
    const status = await api.connectorsStatus();
    mondayConnected.value = status.monday;
    promoMonitorConnected.value = status.promoMonitor;
    promoMonitorEmail.value = status.promoMonitorEmail ?? '';
    slackConnected.value = status.slack;
    slackTeamName.value = status.slackTeamName ?? '';
  });
}

refreshStatus();

function onMondayMessage(event: MessageEvent) {
  if (event.origin !== window.location.origin) return;
  if (event.data?.source !== 'ft-connectors' || event.data?.connector !== 'monday') return;
  window.removeEventListener('message', onMondayMessage);
  if (event.data.ok) mondayConnected.value = true;
  else mondayError.value = typeof event.data.error === 'string' && event.data.error ? event.data.error : 'Não foi possível conectar ao Monday.';
}

// O callback pode rodar num túnel HTTPS (`SLACK_REDIRECT_URI`), outra origem: o status vem do servidor, não da mensagem.
async function onSlackMessage(event: MessageEvent) {
  if (event.data?.source !== 'ft-connectors' || event.data?.connector !== 'slack') return;
  window.removeEventListener('message', onSlackMessage);
  await refreshStatus();
  if (slackConnected.value) return;
  const detail = event.origin === window.location.origin && typeof event.data.error === 'string' ? event.data.error : '';
  slackError.value = detail || 'Não foi possível conectar ao Slack.';
}

onBeforeUnmount(() => {
  window.removeEventListener('message', onMondayMessage);
  window.removeEventListener('message', onSlackMessage);
});

function clickSlack() {
  slackError.value = '';
  window.removeEventListener('message', onSlackMessage);
  window.addEventListener('message', onSlackMessage);
  window.open('/api/connectors/slack/authorize', 'slack-oauth', 'width=600,height=700');
}

function disconnectSlack() {
  return runSlackDisconnect(async () => {
    await api.slackDisconnect();
    slackConnected.value = false;
    slackTeamName.value = '';
  });
}

function clickMonday() {
  if (mondayConnected.value) return;
  mondayError.value = '';
  window.removeEventListener('message', onMondayMessage);
  window.addEventListener('message', onMondayMessage);
  window.open('/api/connectors/monday/authorize', 'monday-oauth', 'width=600,height=700');
}

function disconnectMonday() {
  return runMondayDisconnect(async () => {
    await api.mondayDisconnect();
    mondayConnected.value = false;
  });
}

const connectorsError = computed(
  () => statusError.value || mondayError.value || mondayDisconnectError.value || promoMonitorDisconnectError.value || slackError.value || slackDisconnectError.value,
);

function savePromoMonitor() {
  return runPromoMonitorSave(async () => {
    await api.promoMonitorConnect({ ...promoMonitorForm });
    promoMonitorConnected.value = true;
    promoMonitorEmail.value = promoMonitorForm.email;
    promoMonitorFormOpen.value = false;
    promoMonitorForm.email = '';
    promoMonitorForm.password = '';
    promoMonitorForm.totpSecret = '';
  });
}

function disconnectPromoMonitor() {
  return runPromoMonitorDisconnect(async () => {
    await api.promoMonitorDisconnect();
    promoMonitorConnected.value = false;
    promoMonitorEmail.value = '';
  });
}

const connectors = computed(() => [
  { id: 'monday', label: 'Monday', connected: mondayConnected.value, disconnecting: disconnecting.value, connect: clickMonday, disconnect: disconnectMonday },
  {
    id: 'promo-monitor',
    label: 'Monitor de Promoções',
    connected: promoMonitorConnected.value,
    disconnecting: promoMonitorDisconnecting.value,
    connect: () => { promoMonitorFormOpen.value = !promoMonitorFormOpen.value; },
    disconnect: disconnectPromoMonitor,
  },
  {
    id: 'slack',
    label: slackTeamName.value ? `Slack (${slackTeamName.value})` : 'Slack',
    connected: slackConnected.value,
    disconnecting: slackDisconnecting.value,
    connect: clickSlack,
    disconnect: disconnectSlack,
  },
]);
</script>

<template>
  <ul class="connectors-list">
    <li v-for="connector in connectors" :key="connector.id" class="connectors-list-item">
      <span class="connectors-list-item-label">{{ connector.label }}</span>
      <span v-if="connector.connected" class="connectors-list-item-status">
        <span class="status-saved">conectado</span>
        <button
          type="button"
          class="connectors-list-item-power"
          :disabled="connector.disconnecting"
          :title="connector.disconnecting ? 'Desconectando...' : 'Desconectar'"
          @click="connector.disconnect"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2v8" />
            <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
          </svg>
        </button>
      </span>
      <button v-else type="button" class="connectors-list-item-connect" @click="connector.connect">
        Conectar
      </button>
    </li>
    <li v-if="!promoMonitorConnected && promoMonitorFormOpen" class="promo-monitor-form">
      <div class="field">
        <label for="promo-monitor-email">Usuário (e-mail)</label>
        <input id="promo-monitor-email" v-model="promoMonitorForm.email" type="email" autocomplete="off" />
      </div>
      <div class="field">
        <label for="promo-monitor-password">Senha</label>
        <PasswordField id="promo-monitor-password" v-model="promoMonitorForm.password" autocomplete="off" />
      </div>
      <div class="field">
        <label for="promo-monitor-totp-secret">Chave do autenticador (base32, opcional)</label>
        <PasswordField id="promo-monitor-totp-secret" v-model="promoMonitorForm.totpSecret" autocomplete="off" placeholder="Chave base32" />
      </div>
      <p class="progress-caption">
        Com a chave, o código 2FA é gerado automaticamente. Sem ela, o código de 6 dígitos é pedido a cada consulta de Recorrências.
      </p>
      <p v-if="promoMonitorError" style="color: var(--danger)">{{ promoMonitorError }}</p>
      <button type="button" class="primary" :disabled="promoMonitorSaving" @click="savePromoMonitor">
        {{ promoMonitorSaving ? 'Salvando...' : 'Salvar' }}
      </button>
    </li>
    <li v-if="connectorsError" class="connectors-list-item">
      <span style="color: var(--danger)">{{ connectorsError }}</span>
    </li>
  </ul>
</template>

<style scoped>
.connectors-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.connectors-list-item {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px;
  border-radius: 6px;
}

.connectors-list-item-label {
  flex: 1;
  color: var(--text-primary);
  font-weight: 500;
  padding: 4px 0;
}

.connectors-list-item-status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.connectors-list-item-power {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: var(--danger);
  padding: 4px;
  border-radius: 6px;
  line-height: 0;
}

.connectors-list-item-power:hover:not(:disabled) {
  background: var(--danger-soft);
}

.connectors-list-item-power:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.connectors-list-item-connect {
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: var(--accent-green);
  font-weight: 500;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
}

.connectors-list-item-connect:hover {
  background: var(--accent-green-soft);
}

.promo-monitor-form {
  display: flex;
  flex-direction: column;
  padding: 8px 4px 4px;
}

.promo-monitor-form .field {
  margin-bottom: 10px;
}

.promo-monitor-form .field label {
  font-size: 12px;
}

.promo-monitor-form button.primary {
  align-self: flex-start;
  font-size: 13px;
  padding: 6px 14px;
}
</style>
