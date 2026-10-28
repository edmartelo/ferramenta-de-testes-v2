<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import PasswordField from '../components/PasswordField.vue';
import TotpCodeInput from '../components/TotpCodeInput.vue';
import { api } from '../api';
import { loadAuthState } from '../auth-state';
import { useAsyncAction } from '../composables/useAsyncAction';

const router = useRouter();

/** `new-password` e `authenticator` só no primeiro acesso de quem um Master cadastrou. */
type Step = 'password' | 'code' | 'new-password' | 'authenticator';

const step = ref<Step>('password');
const email = ref('');
const password = ref('');
const code = ref('');
const newPassword = ref('');
const newPasswordConfirm = ref('');
const totpSecret = ref('');
const { pending: submitting, error, run } = useAsyncAction();

function submitPassword() {
  return run(async () => {
    const result = await api.authLoginPassword({ email: email.value, password: password.value });
    step.value = result.setupRequired ? 'new-password' : 'code';
  });
}

function backToPassword() {
  step.value = 'password';
  code.value = '';
  newPassword.value = '';
  newPasswordConfirm.value = '';
  totpSecret.value = '';
  error.value = '';
}

function submitCode() {
  return run(async () => {
    await api.authLogin({ email: email.value, password: password.value, code: code.value });
    await loadAuthState();
    router.push('/');
  });
}

async function submitNewPassword() {
  if (newPassword.value !== newPasswordConfirm.value) {
    error.value = 'As senhas não conferem.';
    return;
  }
  await run(async () => {
    const result = await api.authFirstAccess({ email: email.value, password: password.value, newPassword: newPassword.value });
    totpSecret.value = result.totpSecret;
    step.value = 'authenticator';
  });
}

const copied = ref(false);

async function copySecret() {
  try {
    await navigator.clipboard.writeText(totpSecret.value);
    copied.value = true;
  } catch {
    error.value = 'Não foi possível copiar. Selecione a chave e copie manualmente.';
  }
}

function confirmFirstAccess() {
  return run(async () => {
    await api.authFirstAccessConfirm({
      email: email.value,
      password: password.value,
      newPassword: newPassword.value,
      totpSecret: totpSecret.value,
      code: code.value,
    });
    await loadAuthState();
    router.push('/');
  });
}
</script>

<template>
  <div class="login-page">
    <div class="card login-card">
      <template v-if="step === 'password'">
        <span class="eyebrow">Ferramenta de Testes</span>
        <h1>Entrar</h1>
        <form @submit.prevent="submitPassword">
          <div class="field">
            <label for="login-email">E-mail</label>
            <input id="login-email" v-model="email" type="email" required autocomplete="username" />
          </div>
          <div class="field">
            <label for="login-password">Senha</label>
            <PasswordField id="login-password" v-model="password" required autocomplete="current-password" />
          </div>
          <p v-if="error" style="color: var(--danger)">{{ error }}</p>
          <button type="submit" class="primary" :disabled="submitting">{{ submitting ? 'Verificando...' : 'Continuar' }}</button>
        </form>
      </template>

      <template v-else-if="step === 'code'">
        <span class="eyebrow">Ferramenta de Testes</span>
        <h1>Código do autenticador</h1>
        <p>{{ email }}</p>
        <form @submit.prevent="submitCode">
          <div class="field">
            <label for="login-code">Código de 6 dígitos</label>
            <TotpCodeInput
              id="login-code"
              v-model="code"
              paste-label="Colar e entrar"
              required
              pattern="\d{6}"
              autocomplete="one-time-code"
              autofocus
              @pasted="submitCode"
              @paste-error="error = $event"
            />
          </div>
          <p v-if="error" style="color: var(--danger)">{{ error }}</p>
          <button type="submit" class="primary" :disabled="submitting">{{ submitting ? 'Entrando...' : 'Entrar' }}</button>
          <button type="button" class="ghost" :disabled="submitting" @click="backToPassword">Voltar</button>
        </form>
      </template>

      <template v-else-if="step === 'new-password'">
        <span class="eyebrow">Primeiro acesso</span>
        <h1>Criar nova senha</h1>
        <p>{{ email }} entrou com uma senha provisória. Escolha a sua senha; no próximo passo você cadastra o autenticador.</p>
        <form @submit.prevent="submitNewPassword">
          <div class="field">
            <label for="first-access-password">Nova senha</label>
            <PasswordField id="first-access-password" v-model="newPassword" required minlength="8" autocomplete="new-password" autofocus />
          </div>
          <div class="field">
            <label for="first-access-password-confirm">Confirmar nova senha</label>
            <PasswordField id="first-access-password-confirm" v-model="newPasswordConfirm" required minlength="8" autocomplete="new-password" />
          </div>
          <p v-if="error" style="color: var(--danger)">{{ error }}</p>
          <button type="submit" class="primary" :disabled="submitting">{{ submitting ? 'Gerando...' : 'Continuar' }}</button>
          <button type="button" class="ghost" :disabled="submitting" @click="backToPassword">Voltar</button>
        </form>
      </template>

      <template v-else>
        <span class="eyebrow">Primeiro acesso</span>
        <h1>Cadastrar autenticador</h1>
        <p>Adicione esta chave num app autenticador (Google Authenticator, Authy, etc.) como conta nova:</p>
        <div class="field">
          <label>Chave (base32)</label>
          <div class="input-prefix">
            <code class="totp-secret">{{ totpSecret }}</code>
            <button type="button" class="ghost" @click="copySecret">{{ copied ? 'Copiada' : 'Copiar' }}</button>
          </div>
          <small class="progress-caption">Guarde num lugar seguro — não é mostrada de novo depois de confirmar.</small>
        </div>
        <form @submit.prevent="confirmFirstAccess">
          <div class="field">
            <label for="first-access-code">Código de 6 dígitos</label>
            <input id="first-access-code" v-model="code" required pattern="\d{6}" inputmode="numeric" maxlength="6" autocomplete="one-time-code" />
          </div>
          <p v-if="error" style="color: var(--danger)">{{ error }}</p>
          <button type="submit" class="primary" :disabled="submitting">{{ submitting ? 'Confirmando...' : 'Confirmar e entrar' }}</button>
        </form>
      </template>
    </div>
  </div>
</template>

<style scoped>
.totp-secret {
  display: block;
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 8px 0 0 8px;
  background: var(--surface-hover);
  font-size: 14px;
  letter-spacing: 1px;
  word-break: break-all;
}
</style>
