<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import EditSaveFooter from './EditSaveFooter.vue';
import { api, type MechanicsRules } from '../api';
import { useEditableSave } from '../composables/useEditableSave';

const props = defineProps<{ id: string; mechanicsRules: MechanicsRules | undefined }>();

const minCouponValue = ref('');
const maxCouponsPerDay = ref('');
const maxCouponsTotal = ref('');
const minProductsPerCoupon = ref('');

const { isEditing, justSaved, saving, error, edit, save: saveWith } = useEditableSave(false);
const neverConfigured = ref(true);

function applyRules(rules: MechanicsRules | undefined) {
  minCouponValue.value = rules?.minCouponValue != null ? String(rules.minCouponValue) : '';
  maxCouponsPerDay.value = rules?.maxCouponsPerDay != null ? String(rules.maxCouponsPerDay) : '';
  maxCouponsTotal.value = rules?.maxCouponsTotal != null ? String(rules.maxCouponsTotal) : '';
  minProductsPerCoupon.value = rules?.minProductsPerCoupon != null ? String(rules.minProductsPerCoupon) : '';
  neverConfigured.value = rules == null;
}

watch(
  [() => props.id, () => props.mechanicsRules],
  ([, rules]) => {
    error.value = '';
    applyRules(rules);
    isEditing.value = neverConfigured.value;
  },
  { immediate: true },
);

const disabled = computed(() => !isEditing.value);

/** `v-model` em `<input type="number">` entrega `number` mesmo sem `.number`. */
function toOptionalNumber(text: string | number, { integer = false } = {}): number | undefined {
  const value = String(text);
  if (!value.trim()) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return integer ? Math.trunc(n) : n;
}

/** `step="1"` sozinho não impede digitar/colar "5.5". */
function digitsOf(event: Event): string {
  return (event.target as HTMLInputElement).value.replace(/[^\d]/g, '');
}

function blockDecimalKeys(event: KeyboardEvent) {
  if (['.', ',', 'e', 'E', '+', '-'].includes(event.key)) event.preventDefault();
}

async function save() {
  const rules: MechanicsRules = {
    minCouponValue: toOptionalNumber(minCouponValue.value),
    maxCouponsPerDay: toOptionalNumber(maxCouponsPerDay.value, { integer: true }),
    maxCouponsTotal: toOptionalNumber(maxCouponsTotal.value, { integer: true }),
    minProductsPerCoupon: toOptionalNumber(minProductsPerCoupon.value, { integer: true }),
  };
  await saveWith(async () => {
    await api.saveMechanicsRules(props.id, rules);
    neverConfigured.value = false;
  });
}
</script>

<template>
  <div class="card env-column">
    <h3>Mecânica da promoção</h3>

    <p class="progress-caption">Vale para a promoção inteira, em todos os ambientes.</p>

    <form @submit.prevent="save">
      <div class="field">
        <label for="mec-valor-min">Valor mínimo do cupom (opcional)</label>
        <div class="input-prefix">
          <span class="input-prefix-tag">R$</span>
          <input id="mec-valor-min" v-model="minCouponValue" :disabled="disabled" type="number" step="0.01" min="0" placeholder="ex.: 5,00" />
        </div>
      </div>
      <div class="field">
        <label for="mec-max-dia">Quantidade máxima de cupons por dia (opcional)</label>
        <input id="mec-max-dia" v-model="maxCouponsPerDay" :disabled="disabled" type="number" step="1" min="0" inputmode="numeric" placeholder="ex.: 5" @keydown="blockDecimalKeys" @input="maxCouponsPerDay = digitsOf($event)" />
      </div>
      <div class="field">
        <label for="mec-max-total">Quantidade máxima de cupons na promoção (opcional)</label>
        <input id="mec-max-total" v-model="maxCouponsTotal" :disabled="disabled" type="number" step="1" min="0" inputmode="numeric" placeholder="ex.: 100" @keydown="blockDecimalKeys" @input="maxCouponsTotal = digitsOf($event)" />
      </div>
      <div class="field">
        <label for="mec-min-produtos">Quantidade mínima de produtos por cupom (opcional)</label>
        <input id="mec-min-produtos" v-model="minProductsPerCoupon" :disabled="disabled" type="number" step="1" min="0" inputmode="numeric" placeholder="ex.: 1" @keydown="blockDecimalKeys" @input="minProductsPerCoupon = digitsOf($event)" />
      </div>

      <p v-if="error" role="alert" style="color: var(--danger)">{{ error }}</p>

      <EditSaveFooter :just-saved="justSaved" :is-editing="isEditing" :saving="saving" @edit="edit" />
    </form>
  </div>
</template>
