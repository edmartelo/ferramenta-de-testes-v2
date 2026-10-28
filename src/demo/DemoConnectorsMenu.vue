<script setup lang="ts">
import { computed, ref } from 'vue';
import { useModalDialog } from '../composables/useModalDialog';

/** Build da demo: troca `ConnectorsMenu.vue`. Nada conecta de verdade; cada conector abre uma janela explicando o que faz. */

interface DemoConnector {
  id: string;
  label: string;
  connected: boolean;
  paragraphs: string[];
}

const CONNECTORS: DemoConnector[] = [
  {
    id: 'monday',
    label: 'Monday',
    connected: true,
    paragraphs: [
      'Liga a ferramenta aos quadros do Monday da equipe: abre os itens de cada projeto, comenta e envia o resultado da revisão manual como item ou atualização no quadro.',
      'Na versão completa a conexão é feita pelo login do próprio Monday (OAuth); a ferramenta não guarda a senha.',
      'Na demonstração ela já vem conectada a quadros fictícios, em Ferramentas → Monday: mude status, responsáveis e prazos, crie itens e grupos, comente e abra subitens. Nada sai do navegador e tudo volta ao original ao recarregar a página.',
    ],
  },
  {
    id: 'internal-api',
    label: 'API interna',
    connected: true,
    paragraphs: [
      'Conecta a ferramenta à plataforma de origem que você já usa no dia a dia, como o painel administrativo ou o sistema de monitoramento de cada promoção, com os acessos que você mesmo fornece: usuário, senha e, quando houver, o código do autenticador.',
      'Os dados vêm dessa plataforma de origem e são coletados com os seus acessos; a ferramenta não cria nem altera essas informações. O papel dela é a análise e o tratamento: organiza, compara e destaca o que precisa de atenção.',
      'Nas Recorrências, a cada rodada agendada ou sob demanda, a ferramenta consulta a plataforma de origem e reúne o número de participantes, cupons cadastrados e acessos de cada promoção, para identificar rapidamente quedas, picos ou paradas inesperadas sem precisar abrir painel por painel.',
      'Nos Atendimentos, as dúvidas e reclamações recebidas pelo SAC na plataforma de origem passam por uma análise de sentimento feita por um modelo de IA executado localmente com o Ollama, que identifica o tom do participante e classifica a gravidade do caso, destacando problemas que exigem ação, como falhas no cadastro ou a mesma dúvida repetida por vários participantes. Como o modelo roda na própria máquina, os dados dos participantes nunca são enviados a serviços externos.',
      'A conexão é somente leitura: a ferramenta nunca altera informações na plataforma de origem. Na demonstração ela já vem conectada, com dados fictícios.',
    ],
  },
  {
    id: 'slack',
    label: 'Slack',
    connected: false,
    paragraphs: [
      'Envia os resumos de Recorrências e Atendimentos para um canal ou conversa do Slack. Toda mensagem passa por uma janela de revisão antes do envio.',
      'A conexão é feita pelo login do próprio Slack (OAuth).',
    ],
  },
];

const openId = ref<string | null>(null);
const openConnector = computed(() => CONNECTORS.find((connector) => connector.id === openId.value) ?? null);
const dialog = ref<HTMLElement | null>(null);
useModalDialog(dialog, () => openConnector.value !== null);
</script>

<template>
  <ul class="connectors-list">
    <li v-for="connector in CONNECTORS" :key="connector.id" class="connectors-list-item">
      <span class="connectors-list-item-label">{{ connector.label }}</span>
      <span v-if="connector.connected" class="status-saved">conectado</span>
      <button type="button" class="connectors-list-item-connect" @click="openId = connector.id">
        {{ connector.connected ? 'Detalhes' : 'Conectar' }}
      </button>
    </li>
  </ul>

  <Teleport to="body">
    <div v-if="openConnector" class="modal-backdrop" @keydown.esc="openId = null">
      <div ref="dialog" class="card modal-card demo-connector-card" role="dialog" aria-modal="true" :aria-label="openConnector.label">
        <h3>{{ openConnector.label }}</h3>
        <p v-for="paragraph in openConnector.paragraphs" :key="paragraph">{{ paragraph }}</p>
        <p v-if="!openConnector.connected" class="progress-caption">Disponível na versão completa da ferramenta.</p>
        <div class="card-footer">
          <button type="button" class="primary" @click="openId = null">Entendi</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.connectors-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.connectors-list-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border-radius: 6px;
}

.connectors-list-item-label {
  flex: 1;
  color: var(--text-primary);
  font-weight: 500;
  padding: 4px 0;
}

.connectors-list-item-connect {
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: var(--accent-green);
  font-weight: 500;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
}

.connectors-list-item-connect:hover {
  background: var(--accent-green-soft);
}

.demo-connector-card {
  max-width: 440px;
}
</style>
