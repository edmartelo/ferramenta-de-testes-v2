<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api, type LogFilters, type LogTrigger, type LogUser, type StoredLog } from '../api';
import { useAsyncAction } from '../composables/useAsyncAction';
import { errorMessage } from '../composables/utils';
import NavIcon from '../components/NavIcon.vue';
import DemoAccountEventsLog from '../components/DemoAccountEventsLog.vue';
import { authState } from '../auth-state';

const DETAIL_LABELS: Record<string, string> = {
  promocoes: 'Promoções',
  promocoesComFalha: 'Promoções com falha',
  paineisAtendimentos: 'Painéis de atendimentos',
  paineisComErro: 'Painéis com erro',
  whatsappEnviado: 'WhatsApp enviado',
  atendimentos: 'Atendimentos',
  resumosDeAtendimentos: 'Resumos de atendimentos',
  resumos: 'Resumos enviados',
  falharam: 'Promoções que falharam',
  comDivergencia: 'Promoções com divergência',
  paineisQueFalharam: 'Painéis que falharam',
  painel: 'Painel',
  duracao: 'Duração',
  destino: 'Destino',
  nomeDoDestino: 'Enviado para',
};

const EMPTY_FORM = { id: '', from: '', to: '', trigger: '' as LogTrigger | '', userId: '', onlyErrors: false };

const logs = ref<StoredLog[]>([]);
const users = ref<LogUser[]>([]);
const usersError = ref('');
const hasMore = ref(false);
const form = reactive({ ...EMPTY_FORM });
const expanded = ref<number>();
const { pending, error, run } = useAsyncAction();
const tab = ref<'recorrencias' | 'demo'>('recorrencias');

/** `date` vem do input como AAAA-MM-DD; o dia é o do fuso local. */
function dayStart(date: string, offsetDays = 0): number | undefined {
  if (!date) return undefined;
  const day = new Date(`${date}T00:00`);
  day.setDate(day.getDate() + offsetDays);
  return day.getTime();
}

function filters(): LogFilters {
  return {
    id: Number(form.id) || undefined,
    from: dayStart(form.from),
    to: dayStart(form.to, 1),
    trigger: form.trigger || undefined,
    userId: form.userId || undefined,
    onlyErrors: form.onlyErrors,
  };
}

function load(append = false) {
  return run(async () => {
    const before = append ? logs.value.at(-1)?.id : undefined;
    const page = await api.listLogs('recorrencias', { ...filters(), before });
    logs.value = append ? [...logs.value, ...page.logs] : page.logs;
    hasMore.value = page.hasMore;
  });
}

function clearFilters() {
  Object.assign(form, EMPTY_FORM);
  return load();
}

function toggle(id: number) {
  expanded.value = expanded.value === id ? undefined : id;
}

function detailValue(value: number | string | boolean): string {
  return typeof value === 'boolean' ? (value ? 'sim' : 'não') : String(value);
}

onMounted(() => {
  load();
  api.listLogUsers('recorrencias').then(
    (list) => (users.value = list),
    (e) => (usersError.value = `Lista de usuários não carregou: ${errorMessage(e)}`),
  );
});
</script>

<template>
  <div>
    <span class="eyebrow">{{ tab === 'demo' ? 'Demo' : 'Recorrências' }}</span>
    <h1>Logs</h1>

    <nav v-if="authState.role === 'master'" class="logs-tabs">
      <button type="button" class="logs-tab" :class="{ active: tab === 'recorrencias' }" @click="tab = 'recorrencias'">Logs internos</button>
      <button type="button" class="logs-tab" :class="{ active: tab === 'demo' }" @click="tab = 'demo'">Logs da demo</button>
    </nav>

    <DemoAccountEventsLog v-if="tab === 'demo'" />
    <div v-else class="card logs-card">
      <form class="logs-filters" @submit.prevent="load()">
        <label>
          ID
          <input v-model.trim="form.id" type="text" inputmode="numeric" placeholder="#" />
        </label>
        <label>
          De
          <input v-model="form.from" type="date" @change="load()" :max="form.to || undefined" />
        </label>
        <label>
          Até
          <input v-model="form.to" type="date" @change="load()" :min="form.from || undefined" />
        </label>
        <label>
          Tipo
          <select v-model="form.trigger" @change="load()">
            <option value="">Todos</option>
            <option value="agendada">Agendada</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        <label>
          Usuário
          <select v-model="form.userId" @change="load()">
            <option value="">Todos</option>
            <option v-for="user in users" :key="user.id" :value="user.id">{{ user.name ?? 'Usuário removido' }}</option>
          </select>
        </label>
        <label class="inline"><input v-model="form.onlyErrors" type="checkbox" class="theme-checkbox" @change="load()" /> Só erros</label>
        <div class="filter-actions">
          <button type="submit" class="primary" :disabled="pending">Filtrar</button>
          <button type="button" class="ghost" :disabled="pending" @click="clearFilters">Limpar</button>
          <button type="button" class="ghost" :disabled="pending" title="Recarrega com os filtros atuais" @click="load()">{{ pending ? 'Atualizando...' : 'Atualizar' }}</button>
        </div>
      </form>
      <p v-if="usersError" class="error">{{ usersError }}</p>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-else-if="!pending && logs.length === 0" class="hint">Nenhum log encontrado.</p>
      <div v-if="logs.length > 0" class="table-scroll">
        <table class="logs-table">
          <thead>
            <tr>
              <th><span class="visually-hidden">Detalhes</span></th>
              <th>#</th>
              <th>Data</th>
              <th>Usuário</th>
              <th>Tipo</th>
              <th>Ação</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="log in logs" :key="log.id">
              <tr :class="{ clickable: log.details, open: expanded === log.id }" @click="log.details && toggle(log.id)">
                <td class="toggle-cell">
                  <button
                    v-if="log.details"
                    type="button"
                    class="details-toggle"
                    :aria-expanded="expanded === log.id"
                    :aria-label="expanded === log.id ? 'Esconder detalhes' : 'Ver detalhes'"
                    @click.stop="toggle(log.id)"
                  >
                    <NavIcon name="chevron" />
                  </button>
                </td>
                <td class="id">{{ log.id }}</td>
                <td class="nowrap">{{ new Date(log.createdAt).toLocaleString('pt-BR') }}</td>
                <td>{{ log.userName ?? (log.userId ? 'Usuário removido' : '—') }}</td>
                <td>{{ log.trigger === 'agendada' ? 'Agendada' : 'Manual' }}</td>
                <td>{{ log.action }}</td>
                <td>
                  <span class="status" :class="log.ok ? 'ok' : 'fail'">{{ log.ok ? 'OK' : 'Erro' }}</span>
                  {{ log.message }}
                </td>
              </tr>
              <tr v-if="expanded === log.id && log.details" class="details-row">
                <td></td>
                <td colspan="6">
                  <dl class="details">
                    <template v-for="(value, key) in log.details" :key="key">
                      <dt>{{ DETAIL_LABELS[key] ?? key }}</dt>
                      <dd>{{ detailValue(value) }}</dd>
                    </template>
                  </dl>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <button v-if="hasMore" type="button" class="ghost more" :disabled="pending" @click="load(true)">{{ pending ? 'Carregando...' : 'Carregar mais' }}</button>
      <p v-else-if="pending && logs.length === 0" class="hint">Carregando...</p>
    </div>
  </div>
</template>

<style scoped>
.logs-card {
  margin-top: 20px;
}

.logs-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
}

.logs-tab {
  padding: 10px 16px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--text-secondary);
  font-weight: 600;
}

.logs-tab:hover {
  color: var(--text-primary);
}

.logs-tab.active {
  color: var(--accent-orange);
  border-bottom-color: var(--accent-orange);
}

.logs-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 16px;
}

.logs-filters label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.logs-filters label.inline {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  color: var(--text-primary);
  cursor: pointer;
}

.logs-filters button:not(.ghost) {
  border: 1px solid transparent;
}

.logs-filters input[type='text'] {
  width: 90px;
}

.filter-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.logs-table td:last-child {
  min-width: 200px;
}

.logs-table {
  width: 100%;
  border-collapse: collapse;
}

.logs-table th,
.logs-table td {
  padding: 8px 12px 8px 0;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border);
}

.logs-table th {
  color: var(--text-secondary);
  font-weight: 600;
}

.clickable {
  cursor: pointer;
}

.clickable:hover {
  background: var(--surface-hover);
}

.id,
.nowrap {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.status {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.status.ok {
  color: var(--accent-green);
  background: var(--accent-green-soft);
}

.status.fail {
  color: var(--danger);
  background: var(--danger-soft);
}

.toggle-cell {
  width: 28px;
}

.details-toggle {
  display: grid;
  place-items: center;
  padding: 2px;
  background: transparent;
  border-radius: 6px;
}

.details-toggle .nav-icon {
  transform: rotate(-90deg);
  transition: transform 0.15s ease;
}

.open .details-toggle .nav-icon {
  transform: none;
  color: var(--accent-orange);
}

.details-toggle:hover .nav-icon,
.clickable:hover .details-toggle .nav-icon {
  color: var(--accent-orange);
}

.logs-table tr.open td {
  border-bottom-color: transparent;
}

.details-row td {
  background: var(--bg);
}

.details-row td:last-child {
  padding: 10px 12px;
}

.details {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 16px;
  margin: 4px 0;
}

.details dt {
  color: var(--text-secondary);
}

.details dd {
  margin: 0;
  color: var(--text-primary);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .details-toggle .nav-icon {
    transition: none;
  }
}

.more {
  margin-top: 12px;
}

.error {
  color: var(--danger);
}

.hint {
  color: var(--text-secondary);
}
</style>
