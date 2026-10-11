/**
 * The company details form: what the screen holds while the owner types, how it becomes the
 * request, and the checks made before sending (the server checks everything again).
 */
import type { CompanyProfile, Emirate, SaveCompanyRequest } from '@artepool/shared/contracts';
import { normalizePhone, normalizeTrn } from '@artepool/shared';

export interface CompanyForm {
  legalNameAr: string;
  legalNameEn: string;
  tradeNameAr: string;
  tradeNameEn: string;
  vatRegistered: boolean;
  trn: string;
  addressAr: string;
  addressEn: string;
  city: string;
  poBox: string;
  phone: string;
  email: string;
  website: string;
  emirate: Emirate | '';
}

export type CompanyField = keyof CompanyForm;

/** Fields that must not be empty. */
export const REQUIRED = [
  'legalNameAr',
  'legalNameEn',
  'addressAr',
  'addressEn',
] as const satisfies readonly CompanyField[];

export function toForm(company: CompanyProfile | null): CompanyForm {
  return {
    legalNameAr: company?.legalNameAr ?? '',
    legalNameEn: company?.legalNameEn ?? '',
    tradeNameAr: company?.tradeNameAr ?? '',
    tradeNameEn: company?.tradeNameEn ?? '',
    vatRegistered: company?.vatRegistered ?? false,
    trn: company?.trn ?? '',
    addressAr: company?.addressAr ?? '',
    addressEn: company?.addressEn ?? '',
    city: company?.city ?? '',
    poBox: company?.poBox ?? '',
    phone: company?.phone ?? '',
    email: company?.email ?? '',
    website: company?.website ?? '',
    emirate: company?.emirate ?? '',
  };
}

export const sameForm = (a: CompanyForm, b: CompanyForm): boolean =>
  (Object.keys(a) as CompanyField[]).every((key) => a[key] === b[key]);

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Problems found before sending, as `field → masterdata:fields.<code>`. The TRN is only checked
 * (and only sent) when the company is VAT-registered; it is sent as typed.
 */
export function checkForm(form: CompanyForm): Partial<Record<CompanyField, string>> {
  const problems: Partial<Record<CompanyField, string>> = {};
  for (const field of REQUIRED) if (!form[field].trim()) problems[field] = 'required';
  if (form.vatRegistered && !normalizeTrn(form.trn)) problems.trn = 'invalid_trn';
  if (form.phone.trim() && !normalizePhone(form.phone)) problems.phone = 'invalid_phone';
  if (form.email.trim() && !EMAIL.test(form.email.trim())) problems.email = 'invalid_email';
  return problems;
}

export function toRequest(form: CompanyForm, rowVersion: number | undefined): SaveCompanyRequest {
  return {
    legalNameAr: form.legalNameAr.trim(),
    legalNameEn: form.legalNameEn.trim(),
    tradeNameAr: form.tradeNameAr.trim(),
    tradeNameEn: form.tradeNameEn.trim(),
    vatRegistered: form.vatRegistered,
    trn: form.vatRegistered ? form.trn : '',
    addressAr: form.addressAr.trim(),
    addressEn: form.addressEn.trim(),
    city: form.city.trim(),
    poBox: form.poBox.trim(),
    phone: form.phone.trim(),
    email: form.email.trim(),
    website: form.website.trim(),
    emirate: form.emirate === '' ? null : form.emirate,
    // The very first save creates the record: there is no version yet.
    ...(rowVersion === undefined ? {} : { rowVersion }),
  };
}
