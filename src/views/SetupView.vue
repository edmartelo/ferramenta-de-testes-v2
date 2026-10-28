<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import AppCredit from '../components/AppCredit.vue';
import PasswordField from '../components/PasswordField.vue';
import { api } from '../api';
import { loadAuthState } from '../auth-state';
import { useAsyncAction } from '../composables/useAsyncAction';

const router = useRouter();

const name = ref('');
const email = ref('');
const password = ref('');
const passwordConfirm = ref('');
const code = ref('');
const totpSecret = ref('');
const awaitingCode = ref(false);
const { pending: submitting, error, run } = useAsyncAction();

async function startSetup() {
  if (password.value !== passwordConfirm.value) {
    error.value = 'As senhas não conferem.';
    return;
  }
  await run(async () => {
    const result = await api.authSetup({ name: name.value, email: email.value, password: password.value });
    totpSecret.value = result.totpSecret;
    awaitingCode.value = true;
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

function confirmSetup() {
  return run(async () => {
    await api.authSetupConfirm({ name: name.value, email: email.value, password: password.value, totpSecret: totpSecret.value, code: code.value });
    await loadAuthState();
    router.push('/');
  });
}
</script>

<template>
  <div class="login-page">
    <div class="card login-card">
      <template v-if="!awaitingCode">
        <span class="eyebrow">Primeiro acesso</span>
        <h1>Cadastrar Master</h1>
        <p>Ainda não há usuários: este será o Master, que cadastra os demais em Configurações › Usuários. No próximo passo você cadastra um autenticador (Google Authenticator ou similar).</p>
        <form @submit.prevent="startSetup">
          <div class="field">
            <label for="setup-name">Nome</label>
            <input id="setup-name" v-model="name" required autocomplete="name" />
          </div>
          <div class="field">
            <label for="setup-email">E-mail</label>
            <input id="setup-email" v-model="email" type="email" required autocomplete="username" />
          </div>
          <div class="field">
            <label for="setup-password">Senha</label>
            <PasswordField id="setup-password" v-model="password" required minlength="8" autocomplete="new-password" />
          </div>
          <div class="field">
            <label for="setup-password-confirm">Confirmar senha</label>
            <PasswordField id="setup-password-confirm" v-model="passwordConfirm" required minlength="8" autocomplete="new-password" />
          </div>
          <p v-if="error" style="color: var(--danger)">{{ error }}</p>
          <button type="submit" class="primary" :disabled="submitting">{{ submitting ? 'Gerando...' : 'Continuar' }}</button>
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
        <form @submit.prevent="confirmSetup">
          <div class="field">
            <label for="setup-code">Código de 6 dígitos</label>
            <input id="setup-code" v-model="code" required pattern="\d{6}" inputmode="numeric" maxlength="6" autocomplete="one-time-code" />
          </div>
          <p v-if="error" style="color: var(--danger)">{{ error }}</p>
          <button type="submit" class="primary" :disabled="submitting">{{ submitting ? 'Confirmando...' : 'Confirmar e entrar' }}</button>
        </form>
      </template>
    </div>
    <AppCredit />
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
