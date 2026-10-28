import type { AgencyProfile } from './types.ts';

export const agenciaHorizonte: AgencyProfile = {
  id: 'agencia-horizonte',
  name: 'Horizonte Digital',
  exampleClients: ['Cliente Exemplo'],
  hasInternalSupport: false,
  supportNotes: 'Dados do formulário de atendimento vão para um e-mail do cliente.',
  registrationDocumentTypes: ['cpf'],
  registrationFlow: 'phased',

  registrationPhases: [
    { name: 'Fase 1 — Dados Pessoais', fields: ['CPF', 'Nome', 'Sobrenome', 'UF', 'Data de Nascimento', 'Gênero', 'Celular', 'Telefone'] },
    { name: 'Fase 2 — Acesso', fields: ['E-mail', 'Confirmação de E-mail', 'Senha', 'Confirmação de Senha'] },
    {
      name: 'Fase 3 — Opt-ins e Preferências',
      fields: [
        'Opt-in Concessão de Utilização de Dados (obrigatório)',
        'Opt-in Ciência de Guardar os Cupons Fiscais (obrigatório)',
        'Opt-in Regulamento (obrigatório)',
        'Opt-in Informações do Cliente',
        'Opt-in Mensagens WhatsApp',
        'Como ficou sabendo',
      ],
    },
  ],

  participantFields: [
    { field: 'CPF', rules: 'CPF válido' },
    { field: 'Nome', rules: 'Mín. 2 caracteres; sem caracteres especiais ou números' },
    { field: 'Sobrenome', rules: 'Mín. 3 caracteres; sem caracteres especiais ou números' },
    { field: 'UF', rules: 'Campo obrigatório', required: true },
    { field: 'Nascimento', rules: 'Validar maioridade (+18 anos)' },
    { field: 'Gênero', rules: 'Masculino / Feminino / Não binário / Prefiro não responder / Outro' },
    { field: 'Celular', rules: 'Validar DDD + dígito 9 + total de 11 caracteres' },
    { field: 'Telefone', rules: 'Validar DDD + dígito 9 + total de 11 caracteres' },
    { field: 'E-mail', rules: 'Formato válido (ex: mail@exemplo.com.br)' },
    { field: 'Opt-in Regulamento', rules: 'Obrigatório', required: true },
    { field: 'Opt-in WhatsApp e Notícias', rules: 'Não obrigatório' },
    { field: 'Como ficou sabendo', rules: 'Campo presente no cadastro' },
    { field: 'Captcha', rules: 'Google' },
  ],

  couponRegistration: {
    fields: [
      { field: 'CNPJ', rules: 'Com validador' },
      { field: 'COO', rules: 'Somente números' },
      { field: 'Data de compra', rules: 'Validar período da promoção' },
      { field: 'Categoria de produtos', rules: 'Dropdown' },
      { field: 'Produtos', rules: 'Dropdown' },
      { field: 'Imagem do cupom', rules: 'Aceitar somente JPG, JPEG, PNG ou PDF' },
      { field: 'Quantidade', rules: 'Somente numérico; máx. 999' },
      { field: 'Captcha', rules: 'Obrigatório', required: true },
    ],
    methods: ['form'],
    businessRulesRef: 'config/app.php',
  },

  giftsRedemption: {
    fields: [
      { field: 'CEP', rules: 'Com busca de endereço' },
      { field: 'UF', rules: '' },
      { field: 'Cidade', rules: '' },
      { field: 'Bairro', rules: '' },
      { field: 'Endereço', rules: '' },
      { field: 'Número', rules: '' },
      { field: 'Complemento', rules: '' },
      { field: 'Captcha', rules: '' },
    ],
    notes: [
      'Quantidade de brindes por participante, valor em selos e selos por cupom/produto: conforme mecânica (parâmetros em config/app.php).',
      'Brinde não resgatado com saldo disponível: botão "Resgatar" ativo.',
      'Brinde que exige mais selos do que o saldo do participante: botão "Resgatar" inativo (ex: brinde = 7 selos, saldo = 2 selos).',
      'Se a promoção permitir só 1 resgate por brinde: inativar o botão após o resgate.',
      'Brinde com estoque esgotado: botão inativo com texto "Esgotado".',
      'Painel exibe o saldo de selos do participante em Detalhes do Participante, e o histórico de resgates.',
    ],
  },

  dashboard: {
    fields: [
      'Total de cadastros',
      'Cadastros com envio de cupom (validar filtro: data de cadastro do participante ou do cupom)',
      'Cadastros sem envio de cupom',
      'Total de números regulares',
      'Total de números aceleradores',
      'Total de números (regulares + aceleradores)',
      'Total de selos',
      'Total de cupons',
      'Total de produtos cadastrados',
      'Total de resgates (se houver mais de um brinde, validar total por brinde + total geral)',
    ],
    charts: [
      'Gênero',
      'Como ficou sabendo',
      'Estados participantes (se houver descrição na mecânica)',
      'Cadastro de participantes por dia',
      'Cadastro de cupons por dia',
      'Ranking de produtos (se houver)',
      'Cadastro com compra (com ou sem participação)',
      'Participantes por faixa etária',
      'Comportamento do site (Desktop, Mobile e WhatsApp)',
    ],
  },

  notes: [
    'Regras de negócio (limites de números da sorte, limite de prêmio instantâneo, valores mín/máx, quantidades mínimas de produtos) ficam em config/app.php no backend — validar contra produção; usar PromotionConfig.paths.backend pra consultar o arquivo real.',
    'Se o cupom for reprovado, o prêmio instantâneo vinculado é moderado só com status "reprovado"; se o instantâneo for reprovado, o participante pode concorrer a outro ao cadastrar novo cupom.',
    'Geralmente 1 prêmio instantâneo por CPF (confirmar na mecânica).',
  ],
};
