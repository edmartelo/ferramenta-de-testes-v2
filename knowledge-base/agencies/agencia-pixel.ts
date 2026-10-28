import type { AgencyProfile } from './types.ts';

// "Cliente Exemplo" é cliente da agência (não agência); só ele usa `platformIntegration`.
export const agenciaPixel: AgencyProfile = {
  id: 'agencia-pixel',
  name: 'Pixel & Cia',
  exampleClients: ['Cliente Exemplo'],
  hasInternalSupport: false,
  supportNotes: 'Dados do formulário de atendimento vão para um e-mail do cliente.',
  registrationDocumentTypes: ['cpf', 'cnpj'],
  registrationFlow: 'single-step',

  dualDocumentBehavior: {
    clearsFormOnTypeSwitch: true,
    existingDocumentShowsOptInOnly: true,
  },

  participantFieldsByDocType: {
    cpf: [
      { field: 'CPF', rules: 'CPF válido' },
      { field: 'Nome Completo', rules: 'Mín. 2 caracteres; mín. 2 nomes; sem caracteres especiais ou números' },
      { field: 'Nascimento', rules: 'Validar maioridade (+18 anos)' },
      { field: 'Celular', rules: 'Validar DDD + dígito 9 + total de 11 caracteres' },
      { field: 'UF', rules: 'Dropdown' },
      { field: 'E-mail', rules: 'Formato válido (ex: mail@exemplo.com.br)' },
      { field: 'Opt-in Regulamento, Dados e Notícias', rules: 'Obrigatório', required: true },
      { field: 'Captcha', rules: 'Google' },
    ],
    cnpj: [
      { field: 'CNPJ', rules: 'CNPJ válido' },
      { field: 'Razão Social', rules: 'Mín. 2 caracteres; mín. 2 nomes; sem caracteres especiais ou números' },
      { field: 'Nome Completo', rules: 'Mín. 2 caracteres; mín. 2 nomes; sem caracteres especiais ou números' },
      { field: 'Nascimento', rules: 'Validar maioridade (+18 anos)' },
      { field: 'Celular', rules: 'Validar DDD + dígito 9 + total de 11 caracteres; pode ser o mesmo já cadastrado em participante PF' },
      { field: 'UF', rules: 'Dropdown' },
      { field: 'E-mail', rules: 'Formato válido (ex: mail@exemplo.com.br)' },
      { field: 'Opt-in Regulamento, Dados e Notícias', rules: 'Obrigatório', required: true },
      { field: 'Captcha', rules: 'Google' },
    ],
  },

  dashboard: {
    fields: ['Total de cadastros', 'Total de números distribuídos'],
    charts: ['UF'],
  },

  platformIntegration: {
    name: 'Cliente Exemplo',
    participantIdSource: 'external',
    externalIdSourceName: 'Plataforma do Cliente Exemplo',
    luckyNumberDistribution: 'external-spreadsheet',
    reportTypes: [
      { id: 'simples', label: 'Relatório Simples' },
      { id: 'completo', label: 'Relatório Completo', accessLevel: 'master' },
    ],
    defaultHasCouponRegistration: false,
  },

  notes: [
    'Os 2 tipos de relatório (Simples/Completo) valem nas condições da integração com a plataforma do cliente.',
    'Ao cadastrar em qualquer promoção desse cliente, os dados devem ser atualizados na plataforma dele (relatórios + aba Detalhes do Participante).',
  ],
};
