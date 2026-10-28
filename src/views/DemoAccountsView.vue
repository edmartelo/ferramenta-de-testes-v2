<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api, type DemoAccount } from '../api';
import ConfirmModal from '../components/ConfirmModal.vue';
import { useAsyncAction } from '../composables/useAsyncAction';

const DAY_MS = 24 * 60 * 60 * 1000;

const accounts = ref<DemoAccount[]>([]);
const form = reactive({ from: '', to: '' });
const { pending: loading, error, run } = useAsyncAction();
const { pending: toggling, error: toggleError, run: runToggle } = useAsyncAction();

/** Datas do filtro no fuso desta máquina; `to` inclui o dia inteiro. */
function range(): { from?: number; to?: number } {
  return {
    from: form.from ? new Date(`${form.from}T00:00:00`).getTime() : undefined,
    to: form.to ? new Date(`${form.to}T00:00:00`).getTime() + DAY_MS : undefined,
  };
}

function load() {
  return run(async () => {
    accounts.value = await api.listDemoAccounts(range());
  });
}

onMounted(load);

const activeLast7Days = computed(() => accounts.value.filter((account) => account.lastLoginAt && account.lastLoginAt > Date.now() - 7 * DAY_MS).length);
const totalLogins = computed(() => accounts.value.reduce((sum, account) => sum + account.loginCount, 0));

function formatDate(epoch: number | null): string {
  return epoch ? new Date(epoch).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

const accountToDelete = ref<DemoAccount>();
const { pending: deleting, error: deleteError, run: runDelete } = useAsyncAction();

async function confirmDelete() {
  const target = accountToDelete.value;
  if (!target || deleting.value) return;
  const ok = await runDelete(async () => {
    await api.deleteDemoAccount(target.id);
    accounts.value = accounts.value.filter((account) => account.id !== target.id);
  });
  if (ok) accountToDelete.value = undefined;
}

function toggle(account: DemoAccount) {
  return runToggle(async () => {
    await api.setDemoAccountDisabled(account.id, !account.disabled);
    account.disabled = !account.disabled;
  });
}

const accountToDisable = ref<DemoAccount>();

function askToggle(account: DemoAccount) {
  toggleError.value = '';
  if (account.disabled) void toggle(account);
  else accountToDisable.value = account;
}

async function confirmDisable() {
  const target = accountToDisable.value;
  if (!target || toggling.value) return;
  if (await toggle(target)) accountToDisable.value = undefined;
}
</script>

<template>
  <div>
    <span class="eyebrow">Configurações</span>
    <h1>Contas da demo</h1>
    <p>Quem se cadastrou na versão de demonstração. Só o cadastro fica no banco; tudo o que eles veem dentro da demo é fictício.</p>

    <form class="demo-filters" @submit.prevent="load">
      <label>De <input v-model="form.from" type="date" :max="form.to || undefined" @change="load" /></label>
      <label>Até <input v-model="form.to" type="date" :min="form.from || undefined" @change="load" /></label>
      <button type="submit" class="ghost" :disabled="loading">{{ loading ? 'Carregando...' : 'Atualizar' }}</button>
    </form>

    <div class="demo-stats">
      <div class="card"><strong>{{ accounts.length }}</strong><span>cadastros no período</span></div>
      <div class="card"><strong>{{ activeLast7Days }}</strong><span>ativos nos últimos 7 dias</span></div>
      <div class="card"><strong>{{ totalLogins }}</strong><span>logins no total</span></div>
    </div>

    <div class="card">
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="toggleError" class="error">{{ toggleError }}</p>
      <p v-if="!error && !loading && accounts.length === 0" class="hint">Nenhum cadastro no período.</p>
      <div v-if="accounts.length" class="table-scroll">
        <table class="demo-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>E-mail</th>
              <th>Empresa</th>
              <th>Cadastro</th>
              <th>Último acesso</th>
              <th>Logins</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="account in accounts" :key="account.id" :class="{ disabled: account.disabled }">
              <td>{{ account.name }}</td>
              <td>{{ account.email }}</td>
              <td>{{ account.company ?? '—' }}</td>
              <td>{{ formatDate(account.createdAt) }}</td>
              <td>{{ formatDate(account.lastLoginAt) }}</td>
              <td>{{ account.loginCount }}</td>
              <td class="actions">
                <button type="button" class="ghost" :disabled="toggling" @click="askToggle(account)">{{ account.disabled ? 'Reativar' : 'Desativar' }}</button>
                <button type="button" class="danger" @click="deleteError = ''; accountToDelete = account">Excluir</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <ConfirmModal
      :open="Boolean(accountToDelete)"
      title="Excluir conta da demo?"
      :description="`A conta de ${accountToDelete?.email} é apagada do banco com todo o histórico (telas e ações) e perde o acesso à demo. Não tem como desfazer, mas o participante pode criar uma conta nova a qualquer momento.`"
      :confirm-label="deleting ? 'Excluindo...' : 'Excluir'"
      cancel-label="Cancelar"
      variant="danger"
      :pending="deleting"
      :error="deleteError"
      @confirm="confirmDelete"
      @cancel="accountToDelete = undefined"
    />

    <ConfirmModal
      :open="Boolean(accountToDisable)"
      title="Desativar conta da demo?"
      :description="`${accountToDisable?.email} não consegue mais entrar na demo até ser reativado.`"
      :confirm-label="toggling ? 'Desativando...' : 'Desativar'"
      cancel-label="Cancelar"
      variant="danger"
      :pending="toggling"
      :error="toggleError"
      @confirm="confirmDisable"
      @cancel="accountToDisable = undefined"
    />
  </div>
</template>

<style scoped>
.demo-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  margin: 16px 0;
}

.demo-filters label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.demo-filters button:not(.ghost) {
  border: 1px solid transparent;
}

.demo-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.demo-stats .card {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.demo-stats strong {
  font-size: 24px;
}

.demo-stats span,
.hint {
  color: var(--text-secondary);
}

.demo-table {
  width: 100%;
  border-collapse: collapse;
}

.demo-table th,
.demo-table td {
  padding: 6px 12px 6px 0;
  text-align: left;
  white-space: nowrap;
}

.demo-table tr.disabled td {
  opacity: 0.5;
}

.demo-table .actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.error {
  color: var(--danger);
}
</style>
