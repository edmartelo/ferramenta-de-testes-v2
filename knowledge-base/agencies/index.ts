import type { AgencyProfile } from './types.ts';
import { agenciaAurora } from './agencia-aurora.ts';
import { agenciaHorizonte } from './agencia-horizonte.ts';
import { agenciaPixel } from './agencia-pixel.ts';

export type { AgencyProfile, FieldRule } from './types.ts';

export const AGENCIES: Record<string, AgencyProfile> = {
  'agencia-aurora': agenciaAurora,
  'agencia-horizonte': agenciaHorizonte,
  'agencia-pixel': agenciaPixel,
};

/** Agência fora da lista; o nome digitado (opcional) vai em `PromotionConfig.agencyName`. */
export const OTHER_AGENCY_ID = 'outro';

export function isAgencyId(id: string): boolean {
  return Object.hasOwn(AGENCIES, id);
}

export function getAgency(id: string): AgencyProfile {
  const agency = isAgencyId(id) ? AGENCIES[id] : undefined;
  if (!agency) {
    throw new Error(`Agência desconhecida "${id}". Agências cadastradas: ${Object.keys(AGENCIES).join(', ')}`);
  }
  return agency;
}
