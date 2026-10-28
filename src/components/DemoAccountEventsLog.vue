<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api, type DemoAccountEvent, type DemoAccountEventFilters, type DemoAccountEventLog } from '../api';
import { useAsyncAction } from '../composables/useAsyncAction';

const EVENT_LABELS: Record<DemoAccountEvent, string> = {
  cadastro: 'Cadastro',
  edicao: 'Edição dos dados',
  exclusao: 'Excluída pelo usuário',
  'exclusao-master': 'Excluída pelo Administrador',
  tela: 'Tela visitada',
  acao: 'Ação na demo',
};

const EMPTY_FORM = { id: '', from: '', to: '', event: '' as DemoAccountEvent | '', search: '' };

const events = ref<DemoAccountEventLog[]>([]);
const hasMore = ref(false);
const form = reactive({ ...EMPTY_FORM });
const { pending, error, run } = useAsyncAction();

/** `date` vem do input como AAAA-MM-DD; o dia é o do fuso local. */
function dayStart(date: string, offsetDays = 0): number | undefined {
  if (!date) return undefined;
  const day = new Date(`${date}T00:00`);
  day.setDate(day.getDate() + offsetDays);
  return day.getTime();
}

function filters(): DemoAccountEventFilters {
  return {
    id: Number(form.id) || undefined,
    from: dayStart(form.from),
    to: dayStart(form.to, 1),
    event: form.event || undefined,
    search: form.search.trim() || undefined,
  };
}

function load(append = false) {
  return run(async () => {
    const before = append ? events.value.at(-1)?.id : undefined;
    const page = await api.listDemoAccountEvents({ ...filters(), before });
    events.value = append ? [...events.value, ...page.events] : page.events;
    hasMore.value = page.hasMore;
  });
}

function clearFilters() {
  Object.assign(form, EMPTY_FORM);
  return load();
}

onMounted(load);
</script>

<template>
  <div class="card events-card">
    <p class="hint">Cada cadastro, edição e exclusão de conta da demo, mais as telas visitadas e ações feitas lá, com nome, e-mail e empresa da hora. Excluir a conta apaga o histórico dela; fica só um registro anônimo da exclusão.</p>
    <form class="events-filters" @submit.prevent="load()">
      <label>
        ID
        <input v-model.trim="form.id" type="text" inputmode="numeric" placeholder="#" />
      </label>
      <label>
        De
        <input v-model="form.from" type="date" :max="form.to || undefined" @change="load()" />
      </label>
      <label>
        Até
        <input v-model="form.to" type="date" :min="form.from || undefined" @change="load()" />
      </label>
      <label>
        Evento
        <select v-model="form.event" @change="load()">
          <option value="">Todos</option>
          <option v-for="(label, event) in EVENT_LABELS" :key="event" :value="event">{{ label }}</option>
        </select>
      </label>
      <label class="search">
        Nome, e-mail, empresa ou detalhe
        <input v-model="form.search" type="search" maxlength="100" />
      </label>
      <div class="filter-actions">
        <button type="submit" class="primary" :disabled="pending">Filtrar</button>
        <button type="button" class="ghost" :disabled="pending" @click="clearFilters">Limpar</button>
        <button type="button" class="ghost" :disabled="pending" title="Recarrega com os filtros atuais" @click="load()">{{ pending ? 'Atualizando...' : 'Atualizar' }}</button>
      </div>
    </form>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="!pending && events.length === 0" class="hint">Nenhum registro encontrado.</p>
    <div v-if="events.length > 0" class="table-scroll">
      <table class="events-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Data</th>
            <th>Evento</th>
            <th>Detalhe</th>
            <th>Nome</th>
            <th>E-mail</th>
            <th>Empresa</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="event in events" :key="event.id">
            <td class="nowrap">{{ event.id }}</td>
            <td class="nowrap">{{ new Date(event.createdAt).toLocaleString('pt-BR') }}</td>
            <td class="nowrap" :class="{ removed: event.event.startsWith('exclusao') }">{{ EVENT_LABELS[event.event] ?? event.event }}</td>
            <td>{{ event.detail ?? '—' }}</td>
            <td>{{ event.name }}</td>
            <td>{{ event.email }}</td>
            <td>{{ event.company ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <button v-if="hasMore" type="button" class="ghost more" :disabled="pending" @click="load(true)">{{ pending ? 'Carregando...' : 'Carregar mais' }}</button>
  </div>
</template>

<style scoped>
.events-card {
  margin-top: 20px;
}

.events-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  margin: 12px 0 16px;
}

.events-filters label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.events-filters button:not(.ghost) {
  border: 1px solid transparent;
}

.events-filters input[type='text'] {
  width: 90px;
}

.events-filters .search input {
  width: 220px;
}

.filter-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.events-table {
  width: 100%;
  border-collapse: collapse;
}

.events-table th,
.events-table td {
  padding: 8px 12px 8px 0;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border);
}

.events-table th {
  color: var(--text-secondary);
  font-weight: 600;
}

.nowrap {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.removed {
  color: var(--danger);
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
