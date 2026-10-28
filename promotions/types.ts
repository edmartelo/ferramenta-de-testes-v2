/** A UI chama `staging` de `homolog`. */
export type EnvKey = 'dev' | 'staging' | 'production';

export interface PromotionConfig {
  id: string;
  name: string;
  client: string;
  agencyId: string;
  /** Só quando `agencyId` é `outro`. */
  agencyName?: string;

  paths: {
    backend: string;
    frontend: string;
  };

  environments: {
    /** `dev` é a URL do servidor local rodando, não `paths.frontend`. */
    site: { staging?: string; production?: string; dev?: string };
    adminPanel: { staging?: string; production?: string; dev?: string };
    api?: { baseUrl: string };
  };

  dates: { start: string; end: string };

  mechanics: {
    hasCoupon: boolean;
    hasInstantPrizes: boolean;
    hasAccelerators: boolean;
    hasLuckyNumbers: boolean;
    hasWhatsAppBot: boolean;
    hasSuplente: boolean;
  };

  /** Da promoção, não por ambiente. Campo numérico ausente = não informado (sem teste de limite), não zero. */
  mechanicsRules?: MechanicsRules;
  /** Chaves `<grupo>/<id do ManualTest>`. */
  manualTestChecks?: Partial<Record<Exclude<EnvKey, 'dev'>, string[]>>;
  /** Grupo no menu lateral; ausente = `testing`. */
  stage?: PromotionStage;
}

export const PROMOTION_STAGES = ['testing', 'live', 'closed'] as const;
export type PromotionStage = (typeof PROMOTION_STAGES)[number];

export interface MechanicsRules {
  allowMultipleCpf?: boolean;
  allowMultipleEmail?: boolean;
  allowMultiplePhone?: boolean;
  /** Mesma unidade do campo do site (5 = R$ 5,00). */
  minCouponValue?: number;
  maxCouponsPerDay?: number;
  /** Na promoção inteira, não por dia. */
  maxCouponsTotal?: number;
  minProductsPerCoupon?: number;
  /** Promoção que só aceita cupom de loja participante: o cadastro de cupom usa estes CNPJs em vez de um aleatório. */
  participatingStoreCnpjs?: string[];
}
