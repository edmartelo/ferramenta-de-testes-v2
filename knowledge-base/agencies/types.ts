export interface FieldRule {
  field: string;
  rules: string;
  required?: boolean;
}

export interface AgencyProfile {
  id: string;
  name: string;
  exampleClients?: string[];

  hasInternalSupport: boolean;
  supportNotes?: string;

  registrationDocumentTypes: Array<'cpf' | 'cnpj'>;
  dualDocumentBehavior?: {
    clearsFormOnTypeSwitch: boolean;
    existingDocumentShowsOptInOnly: boolean;
  };

  registrationFlow: 'single-step' | 'phased';
  registrationPhases?: Array<{ name: string; fields: string[] }>;

  participantFields?: FieldRule[];
  participantFieldsByDocType?: Partial<Record<'cpf' | 'cnpj', FieldRule[]>>;

  couponRegistration?: {
    fields: FieldRule[];
    methods?: Array<'form' | 'qr-code' | 'manual' | '44-char-key'>;
    integrations?: string[];
    businessRulesRef?: string;
  };

  giftsRedemption?: {
    fields: FieldRule[];
    notes: string[];
  };

  dashboard: { fields: string[]; charts: string[] };

  /** Caso especial de um cliente da agência (ex.: um cliente com plataforma própria), não da agência inteira. */
  platformIntegration?: {
    name: string;
    participantIdSource: 'external';
    externalIdSourceName: string;
    luckyNumberDistribution: 'external-spreadsheet';
    distributionRepo?: string;
    reportTypes: Array<{ id: string; label: string; accessLevel?: 'master' }>;
    defaultHasCouponRegistration: boolean;
  };

  notes?: string[];

}
