import type { AgencyProfile } from './types.ts';

export const agenciaAurora: AgencyProfile = {
  id: 'agencia-aurora',
  name: 'Agência Aurora',
  hasInternalSupport: true,
  registrationDocumentTypes: ['cpf'],
  registrationFlow: 'single-step',

  participantFields: [
    { field: 'CPF', rules: 'CPF válido' },
    { field: 'Nome', rules: 'Mín. 2 caracteres; sem caracteres especiais ou números' },
    { field: 'Sobrenome', rules: 'Mín. 3 caracteres; sem caracteres especiais ou números' },
    { field: 'Nascimento', rules: 'Validar maioridade (+18 anos)' },
    { field: 'Gênero', rules: 'Masculino / Feminino / Não binário / Prefiro não responder / Outro' },
    { field: 'Celular', rules: 'Validar DDD + dígito 9 + total de 11 caracteres' },
    { field: 'CEP', rules: '8 dígitos; formato NNNNN-NNN; busca de endereço; não aceitar 00000-000; aceitar CEP desconhecido desde que tenha 8 dígitos numéricos' },
    { field: 'E-mail', rules: 'Formato válido (ex: mail@exemplo.com.br)' },
    { field: 'Opt-in Regulamento / Política de Privacidade', rules: 'Obrigatório', required: true },
    { field: 'Opt-in WhatsApp e Notícias', rules: 'Não obrigatório' },
    { field: 'Checkbox "Como ficou sabendo"', rules: 'Obrigatório', required: true },
    { field: 'Captcha', rules: 'Google' },
  ],

  couponRegistration: {
    fields: [
      { field: 'Imagem do cupom', rules: 'Aceitar somente JPG, JPEG, PNG ou PDF' },
      { field: 'Quantidade', rules: 'Somente numérico; máx. 999' },
      { field: 'Valor', rules: 'Somente numérico; mín. 0,01; máx. 999 (valor mínimo pode variar conforme mecânica)' },
      { field: 'Captcha', rules: 'Obrigatório', required: true },
    ],
    methods: ['form'],
  },

  dashboard: {
    fields: [
      'Total de cadastros',
      'Cadastros com envio de cupom (validar filtro: data de cadastro do participante ou do cupom)',
      'Cadastros sem envio de cupom',
      'Total de números (regulares + aceleradores, ou separados — validar)',
      'Total de selos',
      'Total de cupons',
      'Total de resgates (se houver mais de um brinde, validar total por brinde + total geral)',
    ],
    charts: [
      'Cadastro de participantes por dia',
      'Cadastro de cupons por dia',
      'Ranking de produtos (se houver)',
      'Cadastro com compra (com ou sem participação)',
      'Participantes por faixa etária',
      'Comportamento do site (Desktop, Mobile e WhatsApp)',
    ],
  },

  notes: [
    'Geralmente 1 prêmio instantâneo por CPF (confirmar na mecânica).',
    'Painel deve sempre incluir a opção "voltar moderação" (checklist 7.18).',
  ],
};
