import type { PromotionConfig } from '../../promotions/types';
import type { Atendimento, AtendimentosSummary, RecurrencesPromotionResult, StoredLog, StoredTestRun } from '../api';
import { DEMO_FAILURES, DEMO_NOT_APPLICABLE, DEMO_TEST_TITLES } from './fake-runner';

/** Tudo aqui é inventado: nenhuma promoção, pessoa, painel ou log real. */

export const DEMO_AGENCIES = [
  { id: 'agencia-aurora', name: 'Agência Aurora (fictícia)' },
  { id: 'agencia-horizonte', name: 'Horizonte Digital (fictícia)' },
  { id: 'agencia-pixel', name: 'Pixel & Cia (fictícia)' },
  { id: 'outro', name: 'Outra' },
];

function promotion(id: string, name: string, client: string, agencyId: string, stage: PromotionConfig['stage'], hasCoupon = true): PromotionConfig {
  const host = `${id}.promo-exemplo.com.br`;
  return {
    id,
    name,
    client,
    agencyId,
    stage,
    paths: { backend: `C:/projetos/${id}/api`, frontend: `C:/projetos/${id}/site` },
    environments: {
      site: { dev: 'http://localhost:3000', staging: `https://homolog.${host}`, production: `https://${host}` },
      adminPanel: { dev: 'http://localhost:8000/painel', staging: `https://homolog-painel.${host}`, production: `https://painel.${host}` },
    },
    dates: { start: '2026-09-01', end: '2026-12-31' },
    mechanics: { hasCoupon, hasInstantPrizes: true, hasAccelerators: false, hasLuckyNumbers: true, hasWhatsAppBot: true, hasSuplente: false },
    mechanicsRules: { allowMultipleCpf: false, allowMultipleEmail: false, allowMultiplePhone: true, minCouponValue: 30, maxCouponsPerDay: 5 },
    manualTestChecks: { staging: [], production: [] },
  };
}

export function demoPromotions(): PromotionConfig[] {
  return [
    promotion('verao-premiado', 'Promo Verão Premiado', 'Sorvetes Polar (fictícia)', 'agencia-aurora', 'testing'),
    promotion('junte-e-ganhe', 'Junte e Ganhe Demo', 'Biscoitos Lua (fictícia)', 'agencia-horizonte', 'testing'),
    promotion('raspou-ganhou', 'Raspou, Ganhou!', 'Refrescos Brisa (fictícia)', 'agencia-pixel', 'live'),
    promotion('show-de-premios', 'Show de Prêmios Exemplo', 'Supermercados Sol (fictícia)', 'agencia-aurora', 'live'),
    promotion('natal-magico', 'Natal Mágico Demo', 'Chocolates Neve (fictícia)', 'agencia-horizonte', 'closed', false),
  ];
}

/** "DD/MM/AAAA HH:mm:ss", como o Monitor mostra. */
export function brDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

export function demoRecurrences(promotions: PromotionConfig[]): RecurrencesPromotionResult[] {
  return promotions
    .filter((p) => p.stage === 'live' || p.stage === 'testing')
    .map((p, index) => {
      const failing = index === 1 ? ['Cupom aprovado sem número da sorte', 'Prêmio instantâneo sem ganhador há mais de 24 h'] : [];
      return {
        name: p.name,
        analyticsCount: (1200 + index * 873).toLocaleString('pt-BR'),
        ok: failing.length === 0,
        failingLines: failing,
        registrationLines: [
          { label: 'Último cadastro de participante', value: brDateTime(minutesAgo(3 + index * 7)) },
          { label: 'Último cadastro de cupom', value: p.mechanics.hasCoupon ? brDateTime(minutesAgo(5 + index * 11)) : 'nenhum' },
        ],
        panelLinks: [
          { label: 'Site', url: p.environments.site.production ?? '' },
          { label: 'Painel', url: p.environments.adminPanel.production ?? '' },
        ],
      };
    });
}

const AWAITING = 'Aguardando resposta do atendimento';

const ATENDIMENTO_TEMPLATES: Omit<Atendimento, 'id' | 'dataRecebimento'>[] = [
  { participante: 'Ana Exemplo', assunto: 'Não consigo cadastrar meu cupom', status: AWAITING, mensagem: 'Tento cadastrar o cupom e aparece "erro inesperado". Já tentei em dois navegadores.' },
  { participante: 'Bruno Fictício', assunto: 'Dúvida sobre o regulamento', status: 'Finalizado', mensagem: 'Posso participar com nota fiscal de outra cidade?' },
  { participante: 'Carla Demonstração', assunto: 'Números da sorte', status: AWAITING, mensagem: 'Cadastrei três cupons e só recebi um número da sorte.' },
  { participante: 'Diego Teste', assunto: 'Cadastro de cupom', status: AWAITING, mensagem: 'O site diz que o CNPJ é inválido, mas está igual ao da nota.' },
  { participante: 'Elisa Modelo', assunto: 'Troca de e-mail', status: 'Aguardando participante', mensagem: 'Quero trocar o e-mail do meu cadastro.' },
  { participante: 'Fábio Amostra', assunto: 'Não consigo cadastrar meu cupom', status: AWAITING, mensagem: 'Aparece "erro inesperado" ao enviar o cupom desde ontem.' },
  { participante: 'Gabi Exemplo', assunto: 'Prêmio instantâneo', status: 'Finalizado', mensagem: 'Como faço para retirar o prêmio que ganhei?' },
];

export function demoAtendimentos(promotionName: string): Atendimento[] {
  const offset = promotionName.length % 3;
  return ATENDIMENTO_TEMPLATES.slice(offset, offset + 5).map((item, index) => ({
    ...item,
    id: String(1040 + offset * 10 + index),
    dataRecebimento: brDateTime(minutesAgo(30 + index * 95)),
  }));
}

export function demoSummary(promotionName: string): AtendimentosSummary {
  const items = demoAtendimentos(promotionName).filter((item) => item.status === AWAITING);
  const couponErrors = items.filter((item) => /cupom|CNPJ/i.test(item.assunto + item.mensagem));
  const others = items.filter((item) => !couponErrors.includes(item));
  return {
    promotionName,
    source: 'regras',
    note: 'Modo demonstração: resumo pré-montado, sem análise por IA.',
    examples: 0,
    classified: 0,
    labels: 0,
    reviewFirst: [],
    visaoGeral: `${items.length} atendimento(s) aguardando a equipe; o principal ponto é erro ao cadastrar cupom.`,
    groups: [
      ...(couponErrors.length ? [{ severity: 'critica' as const, tema: 'Erro ao cadastrar cupom', resumo: 'Participantes relatam erro ao enviar o cupom.', ids: couponErrors.map((item) => item.id) }] : []),
      ...(others.length ? [{ severity: 'alta' as const, tema: 'Números da sorte', resumo: 'Quantidade de números da sorte diferente da esperada.', ids: others.map((item) => item.id) }] : []),
    ],
  };
}

const DEMO_LOG_USERS = [
  { id: 'demo-ana', name: 'Ana Silva (exemplo)' },
  { id: 'demo-joao', name: 'João Souza (exemplo)' },
];

export function demoLogUsers() {
  return DEMO_LOG_USERS;
}

const DEMO_LOG_ACTIONS = [
  { action: 'Consulta das 09:00', trigger: 'agendada' as const },
  { action: 'Consulta de promoções', trigger: 'manual' as const },
  { action: 'Consulta de atendimentos', trigger: 'manual' as const },
  { action: 'Envio no WhatsApp', trigger: 'manual' as const },
  { action: 'Consulta das 14:00', trigger: 'agendada' as const },
];

/** `seed` escolhe ação, usuário e resultado: fixo no histórico inicial, aleatório no que o Atualizar acrescenta. */
function demoLog(id: number, createdAt: number, seed: number): StoredLog {
  const { action, trigger } = DEMO_LOG_ACTIONS[seed % DEMO_LOG_ACTIONS.length]!;
  const user = DEMO_LOG_USERS[seed % DEMO_LOG_USERS.length]!;
  const ok = seed % 9 !== 4;
  return {
    id,
    createdAt,
    userId: user.id,
    userName: user.name,
    source: 'recorrencias',
    trigger,
    action,
    ok,
    message: ok ? 'Concluída.' : 'O painel não respondeu dentro do tempo limite.',
    details: ok ? { promocoes: 4, divergentes: seed % 3 === 0 ? 1 : 0, duracao: `${40 + (seed % 5) * 7} s` } : { duracao: '2 min 00 s' },
  };
}

export function demoLogs(): StoredLog[] {
  return Array.from({ length: 64 }, (_, index) => demoLog(5000 - index, Date.now() - index * 3.7 * 60 * 60 * 1000, index));
}

/** Execuções novas, de agora, com ação, usuário e resultado sorteados. */
export function randomDemoLogs(nextId: number): StoredLog[] {
  const count = 1 + Math.floor(Math.random() * 3);
  return Array.from({ length: count }, (_, index) => demoLog(nextId + count - 1 - index, Date.now() - index * 60_000, Math.floor(Math.random() * 90)));
}

export function demoInitialRun(): StoredTestRun {
  const startedAt = Date.now() - 26 * 60 * 60 * 1000;
  const titles = DEMO_TEST_TITLES['participant-registration']!;
  return {
    runGroup: 'participant-registration',
    total: titles.length,
    results: titles.map((title, index) => ({
      itemId: `participant-registration/${index}`,
      title,
      status: index === 3 ? 'failed' : index === 6 ? 'not-applicable' : 'ok',
      detail: index === 3 ? DEMO_FAILURES[1] : index === 6 ? DEMO_NOT_APPLICABLE[0] : undefined,
    })),
    manualChecks: {},
    error: null,
    startedAt,
    finishedAt: startedAt + 94_000,
  };
}
