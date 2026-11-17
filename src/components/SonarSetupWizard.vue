<script setup lang="ts">
import { nextTick, reactive, ref, watch } from 'vue';
import { connectSonar, DEFAULT_PROXY_URL, sonarConnection, testSonarProxy } from '../demo/sonar-browser';
import PasswordField from './PasswordField.vue';
import SonarCopyBlock from './SonarCopyBlock.vue';
import SonarFirstAnalysis from './SonarFirstAnalysis.vue';

const emit = defineEmits<{ connected: [] }>();

const STEP_KEY = 'demo-sonar-setup-step';
const STEPS = [
  { n: 1, title: 'Instalar o SonarQube' },
  { n: 2, title: 'Criar o token' },
  { n: 3, title: 'Rodar o proxy' },
  { n: 4, title: 'Conectar' },
  { n: 5, title: 'Primeira análise' },
] as const;
const INSTALL_COMMAND = 'docker run -d --name sonarqube -p 9001:9000 sonarqube:community';
const PROXY_COMMAND = 'node sonar-cors-proxy.mjs';
const PROXY_OTHER_PORT_COMMAND = 'node sonar-cors-proxy.mjs --target=http://127.0.0.1:PORTA';

function readStep(): number {
  try {
    const value = Number(sessionStorage.getItem(STEP_KEY));
    return value >= 1 && value <= STEPS.length ? value : 1;
  } catch {
    return 1;
  }
}

const current = ref(readStep());
const verified = reactive<Record<number, boolean>>({});
const toggles = ref<HTMLButtonElement[]>([]);

const proxyUrl = ref(sonarConnection.proxyUrl || DEFAULT_PROXY_URL);
const testing = ref(false);
const testOk = ref('');
const testError = ref('');

const token = ref('');
const connecting = ref(false);
const connectError = ref('');

watch(current, (step) => {
  try {
    sessionStorage.setItem(STEP_KEY, String(step));
  } catch {
    // Sem sessionStorage a etapa vale só enquanto a página estiver aberta.
  }
});

async function open(step: number, focus = false): Promise<void> {
  current.value = step;
  if (!focus) return;
  await nextTick();
  toggles.value[step - 1]?.focus();
}

async function testProxy(): Promise<void> {
  if (testing.value) return;
  testing.value = true;
  testOk.value = '';
  testError.value = '';
  try {
    const check = await testSonarProxy(proxyUrl.value);
    verified[1] = true;
    verified[3] = true;
    testOk.value = `Proxy e SonarQube respondendo (${check.sonarUrl}${check.version ? `, versão ${check.version}` : ''}).`;
  } catch (error) {
    testError.value = error instanceof Error ? error.message : String(error);
  } finally {
    testing.value = false;
  }
}

async function connect(): Promise<void> {
  if (connecting.value) return;
  connecting.value = true;
  connectError.value = '';
  try {
    await connectSonar(proxyUrl.value, token.value);
    token.value = '';
    verified[2] = true;
    verified[4] = true;
    current.value = 5;
    emit('connected');
  } catch (error) {
    connectError.value = error instanceof Error ? error.message : String(error);
  } finally {
    connecting.value = false;
  }
}
</script>

<template>
  <section class="card wizard" aria-labelledby="wizard-title">
    <h2 id="wizard-title">Conectar ao seu SonarQube em 5 etapas</h2>
    <p>Esta tela lê o SonarQube da sua máquina, direto do seu navegador. Siga as etapas na ordem; dá para voltar a qualquer uma.</p>

    <ol class="wizard-steps">
      <li
        v-for="step in STEPS"
        :key="step.n"
        class="wizard-step"
        :class="{ current: current === step.n, done: verified[step.n] }"
        :aria-current="current === step.n ? 'step' : undefined"
      >
        <h3 class="wizard-step-heading">
          <button
            ref="toggles"
            type="button"
            class="wizard-step-toggle"
            :aria-expanded="current === step.n"
            :aria-controls="`wizard-step-${step.n}`"
            @click="open(step.n)"
          >
            <span class="wizard-step-number" aria-hidden="true">{{ verified[step.n] ? '✓' : step.n }}</span>
            <span>Etapa {{ step.n }}: {{ step.title }}</span>
            <span v-if="verified[step.n]" class="wizard-step-status">verificada</span>
          </button>
        </h3>

        <div v-if="current === step.n" :id="`wizard-step-${step.n}`" class="wizard-step-body">
          <template v-if="step.n === 1">
            <p>
              Você precisa do <a href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noopener noreferrer">Docker Desktop</a>
              instalado e aberto.
            </p>
            <p>Num terminal, rode:</p>
            <SonarCopyBlock :code="INSTALL_COMMAND" label="Comando que instala e sobe o SonarQube" />
            <p>A porta 9001 da sua máquina leva para a porta 9000 do SonarQube dentro do container.</p>
            <p>Na primeira vez o download demora. Depois, o SonarQube leva 1 a 2 minutos para subir.</p>
            <p>
              Abra <a href="http://127.0.0.1:9001" target="_blank" rel="noopener noreferrer">http://127.0.0.1:9001</a>. Entre com usuário
              <code>admin</code> e senha <code>admin</code>. O SonarQube pede para trocar a senha: escolha uma nova.
            </p>
          </template>

          <template v-else-if="step.n === 2">
            <p>No SonarQube, clique no seu avatar (canto superior direito) e vá em <strong>My Account → Security</strong>.</p>
            <p>Em <strong>Generate Tokens</strong>: dê um nome (por exemplo, <code>ferramenta-demo</code>), escolha o tipo <strong>User Token</strong> e a validade de 30 dias. Clique em <strong>Generate</strong>.</p>
            <p>Copie o token na hora: o SonarQube mostra só uma vez.</p>
            <p class="wizard-note">
              Cole o token só nesta tela, na etapa 4. Ele fica apenas nesta aba do navegador e vai direto para o proxy na sua máquina. Não passa
              pelo servidor da demo.
            </p>
          </template>

          <template v-else-if="step.n === 3">
            <p>O SonarQube não aceita chamadas de outros sites. Um pequeno programa na sua máquina, o proxy, faz a ponte só para leitura.</p>
            <p>
              Requisito: <a href="https://nodejs.org/" target="_blank" rel="noopener noreferrer">Node.js</a> 18 ou mais novo. Baixe o
              <a href="/sonar-cors-proxy.mjs" download="sonar-cors-proxy.mjs">proxy (sonar-cors-proxy.mjs)</a>.
            </p>
            <p>Num terminal, na pasta onde o arquivo foi salvo, rode:</p>
            <SonarCopyBlock :code="PROXY_COMMAND" label="Comando que liga o proxy" />
            <p>Deixe esse terminal aberto enquanto usa esta tela.</p>
            <p>Se o SonarQube estiver em outra porta, troque PORTA pela porta dele:</p>
            <SonarCopyBlock :code="PROXY_OTHER_PORT_COMMAND" label="Comando que liga o proxy para outra porta" />

            <div class="field wizard-proxy-field">
              <label for="wizard-proxy-test-url">Endereço do proxy</label>
              <input id="wizard-proxy-test-url" v-model="proxyUrl" type="url" inputmode="url" autocomplete="off" :placeholder="DEFAULT_PROXY_URL" />
            </div>
            <button type="button" class="ghost" :disabled="testing" @click="testProxy">{{ testing ? 'Testando...' : 'Testar proxy' }}</button>
            <p v-if="testOk" role="status" class="wizard-ok"><span aria-hidden="true">✓</span> {{ testOk }}</p>
            <p v-if="testError" role="alert" class="wizard-error">{{ testError }}</p>
          </template>

          <template v-else-if="step.n === 4">
            <form class="wizard-form" @submit.prevent="connect">
              <div class="field">
                <label for="wizard-proxy-url">Endereço do proxy</label>
                <input id="wizard-proxy-url" v-model="proxyUrl" type="url" inputmode="url" autocomplete="off" required :placeholder="DEFAULT_PROXY_URL" />
              </div>
              <div class="field">
                <label for="wizard-token">User Token do SonarQube</label>
                <PasswordField id="wizard-token" v-model="token" autocomplete="off" required spellcheck="false" />
              </div>
              <p v-if="connectError" role="alert" class="wizard-error">{{ connectError }}</p>
              <button type="submit" class="primary" :disabled="connecting">{{ connecting ? 'Conectando...' : 'Conectar' }}</button>
            </form>
          </template>

          <template v-else>
            <SonarFirstAnalysis id-prefix="wizard-analysis" />
            <p class="wizard-note">Conecte-se na etapa 4 para ver o resultado na lista de projetos.</p>
          </template>

          <div v-if="step.n < STEPS.length && step.n !== 4" class="wizard-actions">
            <button type="button" :class="step.n === 3 && !verified[3] ? 'ghost' : 'primary'" @click="open(step.n + 1, true)">Próxima etapa</button>
          </div>
        </div>
      </li>
    </ol>

    <p class="field-hint">Funciona no Chrome, no Edge e no Firefox. O Safari bloqueia a ligação de um site https com o proxy local.</p>
  </section>
</template>

<style scoped>
.wizard {
  max-width: 820px;
}

.wizard h2 {
  font-size: 1.1rem;
}

.wizard-steps {
  list-style: none;
  margin: 16px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.wizard-step {
  border: 1px solid var(--border);
  border-radius: 8px;
}

.wizard-step.current {
  border-color: var(--accent-orange);
  background: var(--accent-orange-soft);
}

.wizard-step-heading {
  margin: 0;
  font-size: 15px;
}

.wizard-step-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 14px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
}

.wizard-step-toggle:focus-visible {
  outline: 2px solid var(--accent-orange);
  outline-offset: 2px;
}

.wizard-step-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 13px;
}

.wizard-step.current .wizard-step-number {
  border-color: var(--accent-orange);
  color: var(--accent-orange);
}

.wizard-step.done .wizard-step-number {
  border-color: var(--accent-green);
  background: var(--accent-green-soft);
  color: var(--accent-green);
}

.wizard-step-status {
  margin-left: auto;
  color: var(--accent-green);
  font-size: 12px;
  font-weight: 600;
}

.wizard-step-body {
  padding: 0 14px 14px 50px;
}

.wizard-step-body p {
  margin: 8px 0;
}

.wizard-step-body a {
  color: var(--accent-orange);
}

.wizard-note {
  color: var(--text-primary);
}

.wizard-proxy-field {
  margin-top: 16px;
  max-width: 360px;
}

.wizard-form {
  max-width: 420px;
}

.wizard-ok {
  color: var(--accent-green);
}

.wizard-error {
  color: var(--danger);
}

.wizard-actions {
  margin-top: 12px;
}

@media (max-width: 600px) {
  .wizard-step-body {
    padding-left: 14px;
  }
}
</style>
