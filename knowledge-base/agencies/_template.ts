import type { AgencyProfile } from './types.ts';

// Copie para `<slug>.ts`, preencha, registre em `index.ts` e apague os opcionais que não se aplicam.
export const templateAgency: AgencyProfile = {
  id: 'nome-da-agencia',
  name: 'Nome da Agência',
  exampleClients: [],

  hasInternalSupport: true,
  supportNotes: undefined,

  registrationDocumentTypes: ['cpf'],
  dualDocumentBehavior: undefined,

  registrationFlow: 'single-step',
  registrationPhases: undefined,

  participantFields: [],

  couponRegistration: {
    fields: [],
    methods: ['form'],
  },

  dashboard: {
    fields: [],
    charts: [],
  },

  notes: [],
};
