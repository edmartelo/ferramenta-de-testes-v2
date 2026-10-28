<script setup lang="ts">
import { computed, reactive, ref, watchEffect } from 'vue';
import ConfirmModal from '../components/ConfirmModal.vue';
import EditSaveFooter from '../components/EditSaveFooter.vue';
import EnvironmentTabs from '../components/EnvironmentTabs.vue';
import ManualReviewCard from '../components/ManualReviewCard.vue';
import ManualTestsCard from '../components/ManualTestsCard.vue';
import MassRegistrationButtons from '../components/MassRegistrationButtons.vue';
import MechanicsRulesCard from '../components/MechanicsRulesCard.vue';
import PasswordField from '../components/PasswordField.vue';
import RunGroupButtons from '../components/RunGroupButtons.vue';
import ShowBrowserSwitch from '../components/ShowBrowserSwitch.vue';
import TestExecutionPanel from '../components/TestExecutionPanel.vue';
import TotpCodeModal from '../components/TotpCodeModal.vue';
import { api, type MassRegistrationSummary, type MechanicsRules, type TestGroupSummary } from '../api';
import { authState } from '../auth-state';
import { useEditableSave } from '../composables/useEditableSave';
import { useRunWithPanelAuth } from '../composables/usePanelAuth';
import { useTestRun } from '../composables/useTestRun';
import { errorMessage } from '../composables/utils';

const props = defineProps<{ id: string; env: 'dev' | 'homolog' | 'producao' }>();

const isDev = computed(() => props.env === 'dev');
/** O servidor manda as credenciais escondidas pro Tester e ignora pastas e credenciais que ele enviar. */
const isMaster = computed(() => authState.role === 'master');
/** Na demonstração não há navegador nem dados de acesso reais para editar. */
const isDemo = import.meta.env.MODE === 'demo';
const label = computed(() => ({ dev: 'Dev', homolog: 'Homolog', producao: 'Produção' })[props.env]);
const configKey = computed(() => ({ dev: 'dev', homolog: 'staging', producao: 'production' } as const)[props.env]);

const testRun = reactive(useTestRun(() => props.id, () => props.env));
const showBrowser = ref(false);
const testGroups = ref<TestGroupSummary[]>([]);
const massRegistration = ref<MassRegistrationSummary>({ groups: [], limits: {} });
const massLimit = computed(() => massRegistration.value.limits[configKey.value]);

const promotionName = ref('');
const backend = ref('');
const frontend = ref('');
const site = ref('');
const adminPanel = ref('');
const adminPanelUser = ref('');
const adminPanelPassword = ref('');
const adminPanelTotpSecret = ref('');
const testParticipantCpf = ref('');
const testParticipantPassword = ref('');
const recaptchaSiteKey = ref('');
const recaptchaSecretKey = ref('');
const panelSessionSaved = ref(false);
const mechanicsRules = ref<MechanicsRules | undefined>(undefined);
const manualTestChecks = ref<string[]>([]);
const loading = ref(true);
const { isEditing, justSaved, saving, error, edit, save: saveWith } = useEditableSave();

const { authenticating, authError, totpModalOpen, handleRun, onTotpConfirm, onTotpCancel } = useRunWithPanelAuth(() => props.id, () => props.env, {
  panelSessionSaved,
  canAuthenticatePanel: () => Boolean(adminPanel.value && adminPanelUser.value && adminPanelPassword.value),
  hasTotpSecret: () => Boolean(adminPanelTotpSecret.value),
  runTests: testRun.runTests,
});

const isProduction = computed(() => props.env === 'producao');

interface PendingRun { title: string; description: string; confirmLabel: string; start: () => void }
const pendingRun = ref<PendingRun | undefined>(undefined);

function runLabel(groupId: string | undefined): string {
  if (!groupId) return 'todos os testes';
  const group = [...testGroups.value, ...massRegistration.value.groups].find((item) => item.id === groupId);
  return `"${group?.label ?? groupId}"`;
}

function confirmRun(groupId: string | undefined, start: () => void): void {
  const overwrites = Boolean(testRun.testResults.length || Object.keys(testRun.manualChecks).length);
  const overwriteNote = 'Os resultados e a conferência manual da última rodada deste ambiente serão substituídos.';
  if (isProduction.value) {
    pendingRun.value = {
      title: 'Rodar testes em Produção?',
      description: `Vai rodar ${runLabel(groupId)} no site real de Produção (${site.value}).${overwrites ? ` ${overwriteNote}` : ''}`,
      confirmLabel: 'Rodar em Produção',
      start,
    };
  } else if (overwrites) {
    pendingRun.value = { title: 'Rodar nova bateria de testes?', description: overwriteNote, confirmLabel: 'Rodar e substituir', start };
  } else {
    start();
  }
}

function onRunConfirm(): void {
  const start = pendingRun.value?.start;
  pendingRun.value = undefined;
  start?.();
}

const runDisabledReason = computed(() => {
  if (loading.value) return 'Carregando a promoção...';
  if (!site.value) {
    if (!isMaster.value) return 'Este ambiente ainda não tem o link do site. Peça a um Master para cadastrar.';
    return isDev.value ? 'Salve a URL do servidor local em Dados de acesso antes de iniciar os testes.' : 'Salve o link do site em Dados de acesso antes de iniciar os testes.';
  }
  if (authenticating.value) return 'Autenticando no painel...';
  return '';
});

function resetForm(): void {
  promotionName.value = '';
  testGroups.value = [];
  massRegistration.value = { groups: [], limits: {} };
  backend.value = '';
  frontend.value = '';
  site.value = '';
  adminPanel.value = '';
  adminPanelUser.value = '';
  adminPanelPassword.value = '';
  adminPanelTotpSecret.value = '';
  testParticipantCpf.value = '';
  testParticipantPassword.value = '';
  recaptchaSiteKey.value = '';
  recaptchaSecretKey.value = '';
  panelSessionSaved.value = false;
  mechanicsRules.value = undefined;
  manualTestChecks.value = [];
  isEditing.value = false;
}

watchEffect(async (onCleanup) => {
  // Lidos antes do primeiro `await`: watchEffect só rastreia o que é acessado de forma síncrona.
  const id = props.id;
  const key = configKey.value;
  let stale = false;
  onCleanup(() => { stale = true; });
  loading.value = true;
  error.value = '';
  resetForm();
  let promotion: Awaited<ReturnType<typeof api.getPromotion>>;
  let groups: Awaited<ReturnType<typeof api.listTestGroups>>;
  try {
    [promotion, groups] = await Promise.all([api.getPromotion(id), api.listTestGroups(id)]);
  } catch (e) {
    if (!stale) {
      error.value = errorMessage(e);
      loading.value = false;
    }
    return;
  }
  if (stale) return;
  loading.value = false;
  promotionName.value = promotion.name;
  testGroups.value = groups.groups;
  massRegistration.value = groups.massRegistration;
  backend.value = promotion.paths.backend;
  frontend.value = promotion.paths.frontend;
  site.value = promotion.environments.site[key] ?? '';
  adminPanel.value = promotion.environments.adminPanel[key] ?? '';
  const creds = promotion.credentialValues[key];
  adminPanelUser.value = creds.adminPanelUser ?? '';
  adminPanelPassword.value = creds.adminPanelPassword ?? '';
  adminPanelTotpSecret.value = creds.adminPanelTotpSecret ?? '';
  testParticipantCpf.value = creds.testParticipantCpf ?? '';
  testParticipantPassword.value = creds.testParticipantPassword ?? '';
  recaptchaSiteKey.value = creds.recaptchaSiteKey ?? '';
  recaptchaSecretKey.value = creds.recaptchaSecretKey ?? '';
  panelSessionSaved.value = promotion.panelSessionSaved[key];
  mechanicsRules.value = promotion.mechanicsRules;
  manualTestChecks.value = key === 'dev' ? [] : (promotion.manualTestChecks?.[key] ?? []);
  isEditing.value = isMaster.value && (key === 'dev' ? !(backend.value && frontend.value) : !(site.value && adminPanel.value));
});

const configuredLabel = (value: string) => (value ? '✓ Cadastrado' : '✗ Não cadastrado');

const testerAccessRows = computed(() => [
  { label: isDev.value ? 'Servidor local' : 'Site', value: site.value || '✗ Não cadastrado' },
  { label: 'Painel', value: adminPanel.value || '✗ Não cadastrado' },
  { label: 'Usuário e senha do painel', value: configuredLabel(adminPanelUser.value && adminPanelPassword.value) },
  { label: 'Autenticador (2FA)', value: adminPanelTotpSecret.value ? '✓ Cadastrado' : 'Não cadastrado (pode pedir o código na hora)' },
  ...(isDev.value ? [] : [{ label: 'Participante de teste', value: configuredLabel(testParticipantCpf.value && testParticipantPassword.value) }]),
  { label: 'Sessão do painel', value: panelSessionSaved.value ? '✓ Salva' : 'Não salva' },
]);

const importingDevCredentials = ref(false);

async function importDevCredentials(): Promise<void> {
  importingDevCredentials.value = true;
  error.value = '';
  try {
    const dev = (await api.getPromotion(props.id)).credentialValues.dev;
    const fields = [
      [adminPanelUser, dev.adminPanelUser],
      [adminPanelPassword, dev.adminPanelPassword],
      [adminPanelTotpSecret, dev.adminPanelTotpSecret],
      [recaptchaSiteKey, dev.recaptchaSiteKey],
      [recaptchaSecretKey, dev.recaptchaSecretKey],
    ] as const;
    const filled = fields.filter(([, value]) => value);
    if (!filled.length) {
      error.value = 'Nenhuma credencial preenchida em Dev.';
      return;
    }
    for (const [target, value] of filled) target.value = value!;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    importingDevCredentials.value = false;
  }
}

function save() {
  if (loading.value) return;
  const panel = {
    adminPanelUser: adminPanelUser.value,
    adminPanelPassword: adminPanelPassword.value,
    adminPanelTotpSecret: adminPanelTotpSecret.value,
    recaptchaSiteKey: recaptchaSiteKey.value,
    recaptchaSecretKey: recaptchaSecretKey.value,
  };
  const env = props.env;
  const id = props.id;
  return saveWith(async () => {
    await (env === 'dev'
      ? api.saveDev(id, { backend: backend.value, frontend: frontend.value, site: site.value, adminPanel: adminPanel.value, ...panel })
      : api.saveEnvironment(id, env, {
        site: site.value,
        adminPanel: adminPanel.value,
        ...panel,
        testParticipantCpf: testParticipantCpf.value,
        testParticipantPassword: testParticipantPassword.value,
      }));
  });
}
</script>

<template>
  <div>
    <span class="eyebrow">{{ promotionName }}</span>
    <h1>
      Ambiente de {{ label }}
      <span v-if="isProduction" class="env-badge">⚠ Site real</span>
    </h1>
    <EnvironmentTabs :id="id" />

    <div class="env-layout">
      <section class="card env-column">
        <div class="manual-checklist-header">
          <h3>Rodar testes</h3>
          <ShowBrowserSwitch v-model="showBrowser" :disabled="testRun.running || isDemo" :title="isDemo ? 'Disponível na versão completa da ferramenta.' : undefined" />
        </div>
        <RunGroupButtons
          :groups="testGroups"
          :running="testRun.running"
          :running-group="testRun.runningGroup"
          :disabled="Boolean(runDisabledReason)"
          :disabled-reason="runDisabledReason"
          @run="(group) => confirmRun(group, () => handleRun(showBrowser, group))"
          @stop="testRun.stopTests"
        />
        <MassRegistrationButtons
          v-if="massLimit"
          :groups="massRegistration.groups"
          :limit="massLimit"
          :running="testRun.running"
          :running-group="testRun.runningGroup"
          :disabled="Boolean(runDisabledReason)"
          :disabled-reason="runDisabledReason"
          @run="(group, quantity) => confirmRun(group, () => testRun.runTests(showBrowser, group, quantity))"
          @stop="testRun.stopTests"
        />
        <p v-if="authError && !totpModalOpen" role="alert" style="color: var(--danger)">{{ authError }}</p>
      </section>

      <TestExecutionPanel :run="testRun" />

      <ManualReviewCard :run="testRun" :promotion-name="promotionName" :update-title="`Conferência manual — ${promotionName} (${label})`" />

      <ManualTestsCard v-if="env === 'producao'" :id="id" :env="env" :groups="testGroups" :checked="manualTestChecks" />

      <form v-if="isMaster || isDemo" class="card env-column" @submit.prevent="save">
        <h3>Dados de acesso</h3>
        <template v-if="isDev">
          <div class="field">
            <label for="backend">Caminho da pasta do backend</label>
            <input id="backend" v-model="backend" :disabled="!isEditing" required placeholder="C:/wamp/www/dev/cliente-x/backend" />
          </div>
          <div class="field">
            <label for="frontend">Caminho da pasta do frontend</label>
            <input id="frontend" v-model="frontend" :disabled="!isEditing" required placeholder="C:/wamp/www/dev/cliente-x/frontend" />
          </div>
        </template>
        <div class="field">
          <label :for="`${env}-site`">{{ isDev ? 'URL do servidor local' : 'Link do site' }}</label>
          <input :id="`${env}-site`" v-model="site" :disabled="!isEditing" :required="!isDev" :placeholder="isDev ? 'http://127.0.0.1:3000' : 'https://www.example.com'" />
        </div>
        <div class="field">
          <label :for="`${env}-panel`">{{ isDev ? 'Link do painel local' : 'Link do painel' }}</label>
          <input
            :id="`${env}-panel`"
            v-model="adminPanel"
            :disabled="!isEditing"
            :required="!isDev"
            :placeholder="isDev ? 'http://127.0.0.1:3000/encpainel' : 'https://painel.example.com'"
            :aria-describedby="isDev ? `${env}-panel-hint` : undefined"
          />
          <small v-if="isDev" :id="`${env}-panel-hint`" class="field-hint">O servidor local do projeto precisa estar rodando (npm run dev).</small>
        </div>
        <div class="field">
          <label :for="`${env}-user`">Usuário do painel</label>
          <input :id="`${env}-user`" v-model="adminPanelUser" :disabled="!isEditing" :required="!isDev" autocomplete="off" />
        </div>
        <div class="field">
          <label :for="`${env}-password`">Senha do painel</label>
          <PasswordField :id="`${env}-password`" v-model="adminPanelPassword" :disabled="!isEditing" :required="!isDev" autocomplete="off" />
        </div>
        <div class="field">
          <label :for="`${env}-totp`">Chave do autenticador (2FA, {{ isDev ? 'se o painel exigir' : 'opcional' }})</label>
          <PasswordField :id="`${env}-totp`" v-model="adminPanelTotpSecret" :disabled="!isEditing" autocomplete="off" placeholder="Chave base32" />
        </div>
        <template v-if="!isDev">
          <div class="field">
            <label :for="`${env}-test-cpf`">CPF de participante de teste já cadastrado (opcional)</label>
            <input :id="`${env}-test-cpf`" v-model="testParticipantCpf" :disabled="!isEditing" inputmode="numeric" autocomplete="off" placeholder="Só números" />
          </div>
          <div class="field">
            <label :for="`${env}-test-password`">Senha desse participante (opcional)</label>
            <PasswordField
              :id="`${env}-test-password`"
              v-model="testParticipantPassword"
              :disabled="!isEditing"
              autocomplete="off"
              :aria-describedby="`${env}-test-password-hint`"
            />
            <small :id="`${env}-test-password-hint`" class="field-hint">Usada nos testes que precisam de login, como Meus Dados e Cad Cupom.</small>
          </div>
        </template>
        <div class="field">
          <label :for="`${env}-recaptcha-site`">Chave do site do reCAPTCHA (opcional)</label>
          <PasswordField :id="`${env}-recaptcha-site`" v-model="recaptchaSiteKey" :disabled="!isEditing" autocomplete="off" />
        </div>
        <div class="field">
          <label :for="`${env}-recaptcha-secret`">Chave secreta do reCAPTCHA (opcional)</label>
          <PasswordField :id="`${env}-recaptcha-secret`" v-model="recaptchaSecretKey" :disabled="!isEditing" autocomplete="off" />
        </div>

        <p v-if="error" role="alert" style="color: var(--danger)">{{ error }}</p>

        <p v-if="isDemo" style="color: var(--text-secondary); font-size: 13px">Na demonstração os dados de acesso não podem ser editados.</p>
        <EditSaveFooter v-else :just-saved="justSaved" :is-editing="isEditing" :saving="saving || loading" @edit="edit">
          <button
            v-if="!isDev && isEditing && !justSaved"
            type="button"
            class="ghost"
            :disabled="saving || loading || importingDevCredentials"
            title="Preenche usuário, senha, 2FA e chaves do reCAPTCHA com o que está salvo em Dev"
            @click="importDevCredentials"
          >
            {{ importingDevCredentials ? 'Copiando...' : 'Copiar credenciais de Dev' }}
          </button>
        </EditSaveFooter>

        <p v-if="panelSessionSaved" class="test-status ok">✓ Sessão do painel salva</p>
      </form>

      <section v-else class="card env-column">
        <h3>Dados de acesso</h3>
        <p v-if="loading" class="progress-caption">Carregando...</p>
        <p v-else-if="error" role="alert" style="color: var(--danger)">{{ error }}</p>
        <dl v-else class="readonly-list">
          <template v-for="row in testerAccessRows" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </template>
        </dl>
        <p class="progress-caption">Só um Master cadastra e altera links, senhas e chaves deste ambiente.</p>
      </section>

      <MechanicsRulesCard :id="id" :mechanics-rules="mechanicsRules" />
    </div>

    <TotpCodeModal
      :open="totpModalOpen"
      :description="`Digite o código atual do autenticador do painel${isDev ? ' de Dev' : ''} pra continuar.`"
      :submitting="authenticating"
      :error="authError"
      @confirm="onTotpConfirm"
      @cancel="onTotpCancel"
    />

    <ConfirmModal
      :open="Boolean(pendingRun)"
      :title="pendingRun?.title ?? ''"
      :description="pendingRun?.description ?? ''"
      :confirm-label="pendingRun?.confirmLabel"
      cancel-label="Cancelar"
      :variant="isProduction ? 'danger' : 'primary'"
      @confirm="onRunConfirm"
      @cancel="pendingRun = undefined"
    />
  </div>
</template>
