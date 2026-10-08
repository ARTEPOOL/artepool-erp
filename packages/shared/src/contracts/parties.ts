/**
 * Customers (design 14) and suppliers. Every customer has a type (decision 0032), a unique phone
 * and, when VAT-registered, a unique TRN (decision 0037). New customers start as cash; credit is
 * given separately, with `customers.credit` and a reason (decision 0036).
 */
import { z } from 'zod';
import {
  EMIRATES,
  ListQuery,
  Name,
  NonNegativeIntText,
  OptionalText,
  Reason,
  RowVersion,
  type Emirate,
} from './common';

export const CUSTOMER_TYPES = ['individual', 'contractor', 'company'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];
export type CreditMode = 'cash' | 'credit';

export interface CustomerListItem {
  id: string;
  code: string;
  customerType: CustomerType;
  name: string;
  nameAlt: string | null;
  /** International form (+971…). Null only for the walk-in customer. */
  phone: string | null;
  isVatRegistered: boolean;
  trn: string | null;
  creditMode: CreditMode;
  isWalkIn: boolean;
  isActive: boolean;
}

export const CustomersQuery = ListQuery.extend({
  vat: z.enum(['registered', 'not_registered']).optional(),
});
export type CustomersQuery = z.infer<typeof CustomersQuery>;

export interface CustomersResponse {
  customers: CustomerListItem[];
  total: number;
  counts: { active: number; vatRegistered: number };
}

export interface CustomerDetail extends CustomerListItem {
  phoneAlt: string | null;
  email: string | null;
  addressLine: string | null;
  area: string | null;
  city: string | null;
  poBox: string | null;
  emirate: Emirate | null;
  countryCode: string;
  paymentTermsDays: number;
  /** Fils as whole-number text; "0" for cash customers. */
  creditLimitFils: string;
  preferredLanguage: 'ar' | 'en' | null;
  notes: string | null;
  rowVersion: number;
}

const CustomerFields = z.object({
  customerType: z.enum(CUSTOMER_TYPES),
  name: Name,
  nameAlt: OptionalText(200),
  /** Typed freely (spaces, local 05… form, Arabic digits); stored as +971… */
  phone: z.string().trim().min(1).max(40),
  phoneAlt: OptionalText(40),
  email: OptionalText(200),
  addressLine: OptionalText(300),
  area: OptionalText(100),
  city: OptionalText(100),
  poBox: OptionalText(20),
  emirate: z.enum(EMIRATES).nullable().optional(),
  isVatRegistered: z.boolean(),
  trn: OptionalText(40),
  preferredLanguage: z.enum(['ar', 'en']).nullable().optional(),
  notes: OptionalText(2000),
});

/** A new customer always starts as cash (decision 0036). */
export const CreateCustomerRequest = CustomerFields;
export type CreateCustomerRequest = z.infer<typeof CreateCustomerRequest>;
export const UpdateCustomerRequest = CustomerFields.extend({ rowVersion: RowVersion });
export type UpdateCustomerRequest = z.infer<typeof UpdateCustomerRequest>;

/** Cash, or credit with a limit above 0 and terms of 0–365 days; always with a reason. */
export const SetCustomerCreditRequest = z.object({
  credit: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('cash') }),
    z.object({
      mode: z.literal('credit'),
      creditLimitFils: NonNegativeIntText.refine((v) => v !== '0'),
      paymentTermsDays: z.number().int().min(0).max(365),
    }),
  ]),
  reason: Reason,
  rowVersion: RowVersion,
});
export type SetCustomerCreditRequest = z.infer<typeof SetCustomerCreditRequest>;

// ---------------------------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------------------------

export interface SupplierListItem {
  id: string;
  code: string;
  name: string;
  nameAlt: string | null;
  phone: string | null;
  isVatRegistered: boolean;
  trn: string | null;
  isActive: boolean;
}

export interface SuppliersResponse {
  suppliers: SupplierListItem[];
  total: number;
}

export interface SupplierDetail extends SupplierListItem {
  email: string | null;
  addressLine: string | null;
  city: string | null;
  emirate: Emirate | null;
  countryCode: string;
  paymentTermsDays: number;
  notes: string | null;
  rowVersion: number;
}

const SupplierFields = z.object({
  name: Name,
  nameAlt: OptionalText(200),
  phone: OptionalText(40),
  email: OptionalText(200),
  addressLine: OptionalText(300),
  city: OptionalText(100),
  emirate: z.enum(EMIRATES).nullable().optional(),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/)
    .default('AE'),
  isVatRegistered: z.boolean(),
  trn: OptionalText(40),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
  notes: OptionalText(2000),
});
export const CreateSupplierRequest = SupplierFields;
export type CreateSupplierRequest = z.infer<typeof CreateSupplierRequest>;
export const UpdateSupplierRequest = SupplierFields.extend({ rowVersion: RowVersion });
export type UpdateSupplierRequest = z.infer<typeof UpdateSupplierRequest>;
