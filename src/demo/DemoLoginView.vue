<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppCredit from '../components/AppCredit.vue';
import PasswordField from '../components/PasswordField.vue';
import TotpCodeInput from '../components/TotpCodeInput.vue';
import { authState, loadAuthState } from '../auth-state';
import { useModalDialog } from '../composables/useModalDialog';
import { useAsyncAction } from '../composables/useAsyncAction';
import { demoAuth, mountCaptcha, mountGoogleButton, unmountCaptcha } from './api';
import PrivacyPolicy from './PrivacyPolicy.vue';

const PRIVACY_TEXT =
  'Li e aceito: guardamos nome, e-mail, empresa, datas de acesso e as telas e ações usadas na demonstração, para contato comercial e métricas de uso. ' +
  'Se a conta for excluída, o acesso e os dados são removidos. O cadastro e o login usam o Cloudflare Turnstile contra robôs e podem usar o login do Google, ' +
  'que nos envia só nome e e-mail. Nenhum outro dado é coletado; tudo o que aparece dentro da ferramenta é fictício.';

const router = useRouter();

/** `google-signup`: primeiro acesso pelo Google, falta só empresa e o aceite. */
const mode = ref<'login' | 'signup' | 'google-signup'>('login');
const name = ref('');
const email = ref('');
const company = ref('');
const password = ref('');
const passwordConfirm = ref('');
const privacyAccepted = ref(false);
const code = ref('');
const loginNeedsCode = ref(false);
/** ID token do Google guardado entre o clique e o aceite ou o código do autenticador. */
const googleCredential = ref('');
const googleProfile = ref({ name: '', email: '' });
/** Mesma regra de `server/demo/accounts.ts`. */
const passwordRules = computed(() => [
  { label: 'Mínimo de 8 caracteres', met: password.value.length >= 8 },
  { label: 'Repetir senha', met: passwordConfirm.value !== '' && password.value === passwordConfirm.value },
]);
const notice = ref('');
const { pending: submitting, error, run } = useAsyncAction();

const captchaEl = ref<HTMLElement>();
const googleEl = ref<HTMLElement>();

/** Um widget por formulário: troca de Entrar para Criar conta remonta com a ação certa. */
watch(captchaEl, (el) => (el ? void mountCaptcha(el, mode.value === 'signup' ? 'signup' : 'login') : unmountCaptcha()));
watch(googleEl, (el) => el && void mountGoogleButton(el, continueWithGoogle));
onUnmounted(unmountCaptcha);

function switchMode(next: 'login' | 'signup') {
  mode.value = next;
  error.value = '';
  notice.value = '';
  code.value = '';
  loginNeedsCode.value = false;
  googleCredential.value = '';
}

async function enter(result: { ok: true } | { totpRequired: true } | { signupRequired: true; name: string; email: string }) {
  if ('signupRequired' in result) {
    googleProfile.value = { name: result.name, email: result.email };
    privacyAccepted.value = false;
    mode.value = 'google-signup';
    return;
  }
  if ('totpRequired' in result) {
    mode.value = 'login';
    loginNeedsCode.value = true;
    return;
  }
  await loadAuthState();
  if (!authState.authenticated) throw new Error('O login foi aceito, mas o navegador não guardou a sessão. Permita cookies para este site e tente de novo.');
  const failure = await router.push('/');
  if (failure) throw new Error(`Não foi possível abrir a tela inicial (${failure.message}). Recarregue a página e tente de novo.`);
}

/** Chamado pelo Google: o botão (iframe dele) continua montado até a resposta, só some com `v-show`. */
function continueWithGoogle(credential: string) {
  error.value = '';
  notice.value = '';
  code.value = '';
  loginNeedsCode.value = false;
  googleCredential.value = credential;
  return run(async () => enter(await demoAuth.google({ credential })));
}

const privacyOpen = ref(false);
const privacyDialog = ref<HTMLElement | null>(null);
useModalDialog(privacyDialog, () => privacyOpen.value);

function login() {
  return run(async () => {
    const totp = loginNeedsCode.value ? { code: code.value } : {};
    const result = googleCredential.value
      ? await demoAuth.google({ credential: googleCredential.value, ...totp })
      : await demoAuth.login({ email: email.value, password: password.value, ...totp });
    await enter(result);
  });
}

function googleSignup() {
  return run(async () => enter(await demoAuth.google({ credential: googleCredential.value, company: company.value, privacyAccepted: privacyAccepted.value })));
}

async function signup() {
  if (password.value !== passwordConfirm.value) {
    error.value = 'As senhas não conferem.';
    return;
  }
  await run(async () => {
    const result = await demoAuth.signup({ name: name.value, email: email.value, company: company.value, password: password.value, privacyAccepted: privacyAccepted.value });
    password.value = '';
    passwordConfirm.value = '';
    switchMode('login');
    notice.value = result.message;
  });
}
</script>

<template>
  <div class="login-page">
    <div class="card login-card">
      <span class="eyebrow">Ferramenta de Testes · Demonstração</span>
      <template v-if="mode === 'login'">
        <h1>Entrar</h1>
        <form @submit.prevent="login">
          <template v-if="!googleCredential">
            <div class="field">
              <label for="demo-login-email">E-mail</label>
              <input id="demo-login-email" v-model="email" type="email" required maxlength="254" autocomplete="username" />
            </div>
            <div class="field">
              <label for="demo-login-password">Senha</label>
              <PasswordField id="demo-login-password" v-model="password" required minlength="8" maxlength="128" autocomplete="current-password" />
            </div>
          </template>
          <div v-if="loginNeedsCode" class="field">
            <label for="demo-login-code">Código do autenticador</label>
            <TotpCodeInput
              id="demo-login-code"
              v-model="code"
              paste-label="Colar e entrar"
              required
              pattern="\d{6}"
              autocomplete="one-time-code"
              autofocus
              @pasted="login"
              @paste-error="error = $event"
            />
          </div>
          <p v-if="notice" style="color: var(--accent-green)">{{ notice }}</p>
          <div v-if="!googleCredential" ref="captchaEl" class="demo-captcha"></div>
          <p v-if="error" style="color: var(--danger)">{{ error }}</p>
          <button v-if="!googleCredential || loginNeedsCode" type="submit" class="primary" :disabled="submitting">{{ submitting ? 'Entrando...' : 'Entrar' }}</button>
          <button v-if="googleCredential" type="button" class="ghost" :disabled="submitting" @click="switchMode('login')">Entrar com e-mail e senha</button>
          <button v-else type="button" class="ghost" :disabled="submitting" @click="switchMode('signup')">Criar conta de demonstração</button>
        </form>
        <div v-show="!googleCredential" class="google-area">
          <span class="divider">ou</span>
          <div ref="googleEl" class="google-button"></div>
        </div>
      </template>

      <template v-else-if="mode === 'google-signup'">
        <h1>Criar conta</h1>
        <p>Primeiro acesso com o Google. Confira seus dados e aceite o aviso de privacidade para entrar.</p>
        <form @submit.prevent="googleSignup">
          <div class="field">
            <label>Nome</label>
            <p class="google-profile">{{ googleProfile.name }}</p>
          </div>
          <div class="field">
            <label>E-mail</label>
            <p class="google-profile">{{ googleProfile.email }}</p>
          </div>
          <div class="field">
            <label for="demo-google-company">Empresa (opcional)</label>
            <input id="demo-google-company" v-model="company" maxlength="100" autocomplete="organization" />
          </div>
          <label class="privacy">
            <input v-model="privacyAccepted" type="checkbox" class="theme-checkbox" required />
            <span>{{ PRIVACY_TEXT }} <button type="button" class="link-button" @click.prevent="privacyOpen = true">Política de privacidade</button></span>
          </label>
          <p v-if="error" style="color: var(--danger)">{{ error }}</p>
          <button type="submit" class="primary" :disabled="submitting">{{ submitting ? 'Entrando...' : 'Criar conta e entrar' }}</button>
          <button type="button" class="ghost" :disabled="submitting" @click="switchMode('login')">Cancelar</button>
        </form>
      </template>

      <template v-else>
        <h1>Criar conta</h1>
        <p>Conheça a ferramenta com promoções, testes e atendimentos fictícios.</p>
        <form @submit.prevent="signup">
          <div class="field">
            <label for="demo-signup-name">Nome</label>
            <input id="demo-signup-name" v-model="name" required minlength="2" maxlength="100" autocomplete="name" />
          </div>
          <div class="field">
            <label for="demo-signup-email">E-mail</label>
            <input id="demo-signup-email" v-model="email" type="email" required maxlength="254" autocomplete="email" placeholder="seu.email@dominio.com" />
          </div>
          <div class="field">
            <label for="demo-signup-company">Empresa (opcional)</label>
            <input id="demo-signup-company" v-model="company" maxlength="100" autocomplete="organization" />
          </div>
          <div class="field">
            <label for="demo-signup-password">Senha</label>
            <PasswordField id="demo-signup-password" v-model="password" required minlength="8" maxlength="128" autocomplete="new-password" />
          </div>
          <div class="field">
            <label for="demo-signup-password-confirm">Confirmar senha</label>
            <PasswordField id="demo-signup-password-confirm" v-model="passwordConfirm" required minlength="8" maxlength="128" autocomplete="new-password" />
          </div>
          <ul class="password-rules" aria-label="Exigências de senha">
            <li v-for="rule in passwordRules" :key="rule.label" :class="{ met: rule.met }">
              <span aria-hidden="true">{{ rule.met ? '✓' : '•' }}</span> {{ rule.label }}
            </li>
          </ul>
          <label class="privacy">
            <input v-model="privacyAccepted" type="checkbox" class="theme-checkbox" required />
            <span>{{ PRIVACY_TEXT }} <button type="button" class="link-button" @click.prevent="privacyOpen = true">Política de privacidade</button></span>
          </label>
          <div ref="captchaEl" class="demo-captcha"></div>
          <p v-if="error" style="color: var(--danger)">{{ error }}</p>
          <button type="submit" class="primary" :disabled="submitting">{{ submitting ? 'Enviando...' : 'Criar conta' }}</button>
          <button type="button" class="ghost" :disabled="submitting" @click="switchMode('login')">Já tenho conta</button>
        </form>
        <div class="google-area">
          <span class="divider">ou</span>
          <div ref="googleEl" class="google-button"></div>
        </div>
      </template>
      <p v-if="googleCredential && submitting" class="hint google-status">Entrando com o Google...</p>
      <button type="button" class="link-button privacy-link" @click="privacyOpen = true">Política de privacidade</button>
    </div>
    <AppCredit />

    <div v-if="privacyOpen" class="modal-backdrop" @click.self="privacyOpen = false" @keydown.esc="privacyOpen = false">
      <div ref="privacyDialog" class="card modal-card privacy-modal" role="dialog" aria-modal="true" aria-labelledby="privacy-modal-title">
        <div class="privacy-modal-header">
          <h2 id="privacy-modal-title">Política de privacidade</h2>
          <button type="button" class="ghost" aria-label="Fechar" @click="privacyOpen = false">✕</button>
        </div>
        <PrivacyPolicy />
        <button type="button" class="primary privacy-modal-close" @click="privacyOpen = false">Fechar</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.password-rules {
  list-style: none;
  margin: -4px 0 12px;
  padding: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.password-rules li.met {
  color: var(--accent-green);
}

.demo-captcha:not(:empty) {
  margin-bottom: 12px;
}

.google-area:has(.google-button:empty) {
  display: none;
}

.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 0 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.divider::before,
.divider::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--border);
}

.google-button {
  display: flex;
  justify-content: center;
  min-height: 44px;
}

.google-profile {
  margin: 0;
  color: var(--text-primary);
}

.link-button {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-weight: inherit;
  color: var(--accent-orange);
  cursor: pointer;
}

.link-button:hover {
  text-decoration: underline;
}

.privacy-link {
  display: block;
  margin: 16px auto 0;
  font-size: 13px;
}

.google-status {
  margin: 12px 0 0;
  text-align: center;
}

.privacy-modal {
  max-width: 640px;
  max-height: 85vh;
}

.privacy-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.privacy-modal-header h2 {
  margin: 0;
}

.privacy-modal-close {
  width: 100%;
  margin-top: 16px;
}

.privacy {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-size: 13px;
  line-height: 1.45;
  margin-bottom: 12px;
}
</style>
