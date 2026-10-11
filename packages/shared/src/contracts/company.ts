/**
 * Settings → Company: the details printed on every tax invoice. Everyone signed in may read them;
 * only the owner edits them (decision 0030). Logo: PNG or JPEG, at most 512 KB (decision 0037).
 */
import { z } from 'zod';
import { EMIRATES, Name, OptionalText, RowVersion, type Emirate } from './common';

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_TYPES = ['image/png', 'image/jpeg'] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

export interface CompanyProfile {
  legalNameAr: string;
  legalNameEn: string;
  tradeNameAr: string | null;
  tradeNameEn: string | null;
  vatRegistered: boolean;
  trn: string | null;
  addressAr: string;
  addressEn: string;
  city: string | null;
  poBox: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  emirate: Emirate | null;
  logoType: LogoType | null;
  currency: 'AED';
  rowVersion: number;
  updatedAt: string;
}

export interface CompanyResponse {
  /** Null until the owner saves the details for the first time. */
  company: CompanyProfile | null;
  canEdit: boolean;
}

export const SaveCompanyRequest = z.object({
  legalNameAr: Name,
  legalNameEn: Name,
  tradeNameAr: OptionalText(200),
  tradeNameEn: OptionalText(200),
  vatRegistered: z.boolean(),
  /** Typed freely (spaces, Arabic digits); must be 15 digits starting with 100 when registered. */
  trn: OptionalText(40),
  addressAr: z.string().trim().min(1).max(500),
  addressEn: z.string().trim().min(1).max(500),
  city: OptionalText(100),
  poBox: OptionalText(20),
  phone: OptionalText(40),
  email: OptionalText(200),
  website: OptionalText(200),
  emirate: z.enum(EMIRATES).nullable().optional(),
  /** Absent only for the very first save. */
  rowVersion: RowVersion.optional(),
});
export type SaveCompanyRequest = z.infer<typeof SaveCompanyRequest>;

/** A new logo (or null to remove it). Its content is checked, not just its type. */
export const SaveLogoRequest = z.object({
  logo: z
    .object({
      type: z.enum(LOGO_TYPES),
      dataBase64: z.string().max(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 4),
    })
    .nullable(),
  rowVersion: RowVersion,
});
export type SaveLogoRequest = z.infer<typeof SaveLogoRequest>;

export interface LogoResponse {
  logo: { type: LogoType; dataBase64: string } | null;
}
