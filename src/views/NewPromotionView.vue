<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, type AgencySummary } from '../api';
import { useAsyncAction } from '../composables/useAsyncAction';

const router = useRouter();
const agencies = ref<AgencySummary[]>([]);
const name = ref('');
const client = ref('');
const agencyId = ref('');
const agencyName = ref('');
const { pending: saving, error, run } = useAsyncAction();
const { error: agenciesError, run: runAgencies } = useAsyncAction();

onMounted(() => runAgencies(async () => {
  agencies.value = await api.listAgencies();
  if (agencies.value[0]) agencyId.value = agencies.value[0].id;
}));

async function create() {
  if (!name.value.trim() || !client.value.trim() || !agencyId.value) {
    error.value = 'Preencha nome, cliente e agência.';
    return;
  }
  await run(async () => {
    const promotion = await api.createPromotion({
      name: name.value,
      client: client.value,
      agencyId: agencyId.value,
      agencyName: agencyId.value === 'outro' ? agencyName.value : undefined,
    });
    router.push(`/promotions/${promotion.id}`);
  });
}
</script>

<template>
  <div>
    <span class="eyebrow">Nova promoção</span>
    <h1>Cadastrar promoção</h1>
    <p>Depois de criada, ela entra no histórico e você configura Dev/Homolog/Produção separadamente.</p>

    <form class="card" style="margin-top: 20px; max-width: 420px" @submit.prevent="create">
      <div class="field">
        <label for="name">Nome da promoção</label>
        <input id="name" v-model="name" placeholder="Ex.: Verão Premiado 2026" />
      </div>
      <div class="field">
        <label for="client">Cliente</label>
        <input id="client" v-model="client" placeholder="Ex.: Cliente Exemplo" />
      </div>
      <div class="field">
        <label for="agency">Agência</label>
        <select id="agency" v-model="agencyId">
          <option v-for="a in agencies" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </div>
      <div v-if="agencyId === 'outro'" class="field">
        <label for="agency-name">Nome da agência (opcional)</label>
        <input id="agency-name" v-model="agencyName" placeholder="Ex.: Agência XYZ" />
      </div>

      <p v-if="agenciesError" role="alert" style="color: var(--danger)">{{ agenciesError }}</p>
      <p v-if="error" role="alert" style="color: var(--danger)">{{ error }}</p>

      <button type="submit" class="primary" :disabled="saving">
        {{ saving ? 'Criando...' : 'Criar promoção' }}
      </button>
    </form>
  </div>
</template>
