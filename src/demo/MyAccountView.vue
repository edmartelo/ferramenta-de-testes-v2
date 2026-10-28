<script setup lang="ts">
import QRCode from 'qrcode';
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import PasswordField from '../components/PasswordField.vue';
import TotpCodeInput from '../components/TotpCodeInput.vue';
import { authState, clearAuthState } from '../auth-state';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useModalDialog } from '../composables/useModalDialog';
import { demoAccount } from './api';

/** Só no build da demo: o visitante edita ou apaga a própria conta. */

const router = useRouter();
const form = reactive({ name: '', email: '', company: '', currentPassword: '', newPassword: '' });
const savedEmail = ref('');
/** Conta criada pelo Google não tem senha: cria uma aqui, sem pedir a atual. */
const hasPassword = ref(true);
const totpEnabled = ref(false);
const saved = ref(false);
const { error: loadError, run: runLoad } = useAsyncAction();
const { pending: saving, error: saveError, run: runSave } = useAsyncAction();

runLoad(async () => {
  const account = await demoAccount.get();
  Object.assign(form, { name: account.name, email: account.email, company: account.company ?? '' });
  savedEmail.value = account.email;
  hasPassword.value = account.hasPassword;
  totpEnabled.value = account.totpEnabled;
});

const totpSecret = ref('');
const totpQr = ref('');
const totpCode = ref('');
const totpNotice = ref('');
const { pending: totpPending, error: totpError, run: runTotp } = useAsyncAction();

function startTotp() {
  totpNotice.value = '';
  totpCode.value = '';
  return runTotp(async () => {
    const { totpSecret: secret } = await demoAccount.totpSecret();
    const uri = `otpauth://totp/${encodeURIComponent(`Ferramenta de Testes (demo):${savedEmail.value}`)}?secret=${secret}&issuer=${encodeURIComponent('Ferramenta de Testes')}`;
    totpQr.value = await QRCode.toDataURL(uri, { margin: 1, width: 200 });
    totpSecret.value = secret;
  });
}

function cancelTotp() {
  totpSecret.value = '';
  totpCode.value = '';
  totpError.value = '';
}

function confirmTotp() {
  return runTotp(async () => {
    await demoAccount.enableTotp(totpSecret.value, totpCode.value);
    cancelTotp();
    totpEnabled.value = true;
    totpNotice.value = 'Autenticador ativado. O próximo login vai pedir o código.';
  });
}

const disablingTotp = ref(false);

function disableTotp() {
  return runTotp(async () => {
    await demoAccount.disableTotp(totpCode.value);
    totpCode.value = '';
    disablingTotp.value = false;
    totpEnabled.value = false;
    totpNotice.value = 'Autenticador desativado.';
  });
}

function save() {
  saved.value = false;
  return runSave(async () => {
    const { name } = await demoAccount.update({ ...form });
    authState.name = name;
    savedEmail.value = form.email.trim().toLowerCase();
    if (form.newPassword) hasPassword.value = true;
    form.currentPassword = '';
    form.newPassword = '';
    saved.value = true;
  });
}

const deleteOpen = ref(false);
const deletePassword = ref('');
const deleteEmail = ref('');
const deleteConfirmation = computed(() => (hasPassword.value ? { currentPassword: deletePassword.value } : { confirmEmail: deleteEmail.value }));
const deleteDialog = ref<HTMLElement | null>(null);
useModalDialog(deleteDialog, () => deleteOpen.value);
const { pending: deleting, error: deleteError, run: runDelete } = useAsyncAction();

function openDelete() {
  deletePassword.value = '';
  deleteEmail.value = '';
  deleteError.value = '';
  deleteOpen.value = true;
}

function confirmDelete() {
  return runDelete(async () => {
    await demoAccount.remove(deleteConfirmation.value);
    clearAuthState();
    router.push('/login');
  });
}
</script>

<template>
  <div>
    <span class="eyebrow">Conta</span>
    <h1>Meus dados</h1>
    <p>Edite seus dados de acesso à demonstração. {{ hasPassword ? 'Trocar o e-mail ou a senha pede a senha atual.' : 'Sua conta entra pelo Google; se quiser, crie uma senha para entrar também com e-mail.' }}</p>

    <p v-if="loadError" style="color: var(--danger)">{{ loadError }}</p>
    <div v-else class="card my-account-card">
      <form @submit.prevent="save">
        <div class="field">
          <label for="my-name">Nome</label>
          <input id="my-name" v-model="form.name" required minlength="2" maxlength="100" autocomplete="name" />
        </div>
        <div class="field">
          <label for="my-email">E-mail</label>
          <input id="my-email" v-model="form.email" type="email" required maxlength="254" autocomplete="email" />
        </div>
        <div class="field">
          <label for="my-company">Empresa (opcional)</label>
          <input id="my-company" v-model="form.company" maxlength="100" autocomplete="organization" />
        </div>
        <div class="field">
          <label for="my-new-password">{{ hasPassword ? 'Nova senha (opcional)' : 'Criar senha (opcional)' }}</label>
          <PasswordField id="my-new-password" v-model="form.newPassword" minlength="8" maxlength="128" autocomplete="new-password" />
        </div>
        <div v-if="hasPassword" class="field">
          <label for="my-current-password">Senha atual</label>
          <PasswordField
            id="my-current-password"
            v-model="form.currentPassword"
            :required="form.newPassword !== '' || form.email.trim().toLowerCase() !== savedEmail"
            autocomplete="current-password"
          />
        </div>
        <p v-if="saveError" style="color: var(--danger)">{{ saveError }}</p>
        <p v-if="saved" class="status-saved">Dados salvos.</p>
        <button type="submit" class="primary" :disabled="saving">{{ saving ? 'Salvando...' : 'Salvar' }}</button>
      </form>
    </div>

    <div v-if="!loadError" class="card my-account-card">
      <h3>App autenticador</h3>
      <template v-if="totpEnabled">
        <p>Ativado: o login pede o código de 6 dígitos do app.</p>
        <form v-if="disablingTotp" @submit.prevent="disableTotp">
          <div class="field">
            <label for="my-totp-disable-code">Código atual do app</label>
            <TotpCodeInput id="my-totp-disable-code" v-model="totpCode" paste-label="Colar código" required pattern="\d{6}" autocomplete="one-time-code" @paste-error="totpError = $event" />
          </div>
          <p v-if="totpError" style="color: var(--danger)">{{ totpError }}</p>
          <div class="card-footer">
            <button type="button" class="ghost" @click="disablingTotp = false">Cancelar</button>
            <button type="submit" class="danger" :disabled="totpPending">{{ totpPending ? 'Desativando...' : 'Desativar' }}</button>
          </div>
        </form>
        <button v-else type="button" class="ghost" @click="disablingTotp = true; totpCode = ''; totpError = ''; totpNotice = ''">Desativar autenticador</button>
      </template>
      <template v-else-if="totpSecret">
        <p>Escaneie o QR code com o app autenticador (Google Authenticator, Authy etc.) e digite o código que ele mostrar. Sem câmera, adicione a chave abaixo à mão.</p>
        <img class="totp-qr" :src="totpQr" alt="QR code do autenticador" width="200" height="200" />
        <code class="totp-secret">{{ totpSecret }}</code>
        <form @submit.prevent="confirmTotp">
          <div class="field">
            <label for="my-totp-code">Código de 6 dígitos</label>
            <TotpCodeInput id="my-totp-code" v-model="totpCode" paste-label="Colar código" required pattern="\d{6}" autocomplete="one-time-code" @paste-error="totpError = $event" />
          </div>
          <p v-if="totpError" style="color: var(--danger)">{{ totpError }}</p>
          <div class="card-footer">
            <button type="button" class="ghost" @click="cancelTotp">Cancelar</button>
            <button type="submit" class="primary" :disabled="totpPending">{{ totpPending ? 'Ativando...' : 'Ativar' }}</button>
          </div>
        </form>
      </template>
      <template v-else>
        <p>Opcional: além da senha ou do Google, o login passa a pedir um código do app autenticador do celular.</p>
        <p v-if="totpError" style="color: var(--danger)">{{ totpError }}</p>
        <button type="button" class="primary" :disabled="totpPending" @click="startTotp">{{ totpPending ? 'Gerando...' : 'Configurar autenticador' }}</button>
      </template>
      <p v-if="totpNotice" class="status-saved">{{ totpNotice }}</p>
    </div>

    <div class="card my-account-card">
      <h3>Excluir meu acesso</h3>
      <p>Remove sua conta, o acesso à demonstração e todo o histórico dela (dados, telas e ações). Você pode criar uma conta nova a qualquer momento, inclusive com o mesmo e-mail ou pelo Google.</p>
      <button type="button" class="danger" @click="openDelete">Excluir meu acesso</button>
    </div>

    <div v-if="deleteOpen" class="modal-backdrop" @keydown.esc="deleteOpen = false">
      <div ref="deleteDialog" class="card modal-card my-account-modal" role="alertdialog" aria-modal="true" aria-label="Excluir meu acesso">
        <h3>Excluir meu acesso</h3>
        <p>A conta e o histórico dela são apagados e não voltam, mas você pode criar uma conta nova quando quiser, inclusive com o mesmo e-mail. {{ hasPassword ? 'Digite sua senha para confirmar.' : 'Digite o e-mail da conta para confirmar.' }}</p>
        <form @submit.prevent="confirmDelete">
          <div v-if="hasPassword" class="field">
            <label for="delete-password">Senha</label>
            <PasswordField id="delete-password" v-model="deletePassword" required minlength="8" autocomplete="current-password" />
          </div>
          <div v-else class="field">
            <label for="delete-email">E-mail da conta</label>
            <input id="delete-email" v-model="deleteEmail" type="email" required maxlength="254" autocomplete="off" />
          </div>
          <p v-if="deleteError" style="color: var(--danger)">{{ deleteError }}</p>
          <div class="card-footer">
            <button type="button" class="ghost" @click="deleteOpen = false">Cancelar</button>
            <button type="submit" class="danger" :disabled="deleting">{{ deleting ? 'Excluindo...' : 'Excluir' }}</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.my-account-card {
  max-width: 480px;
  margin-top: 16px;
}

.my-account-modal {
  max-width: 420px;
}

.totp-qr {
  display: block;
  margin: 0 auto 12px;
  border-radius: 8px;
}

.totp-secret {
  display: block;
  margin-bottom: 12px;
  word-break: break-all;
  font-size: 14px;
}
</style>
