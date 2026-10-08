/**
 * Accounting: the provisional chart of accounts, the account used for each event, lines of
 * business and monthly periods (decisions 0016, 0018, 0035). Everything here is data the
 * accountant can change without programming.
 */
import { z } from 'zod';
import { IdText } from './auth';
import { Code, Name, Reason, RowVersion } from './common';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Why an account is in use: it then keeps its type, header choice, control flag and active state. */
export type AccountUse =
  'event_link' | 'business_line' | 'payment_method' | 'reason_code' | 'posted';

export interface AccountItem {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  accountType: AccountType;
  parentId: string | null;
  /** False for header accounts, which group others and never receive postings. */
  isPostable: boolean;
  isControl: boolean;
  isContra: boolean;
  isActive: boolean;
  inUse: AccountUse | null;
  rowVersion: number;
}

/** The events of the posting map (docs/accounting/posting-map.md). */
export const ACCOUNT_LINK_KEYS = [
  'ar_control',
  'ap_control',
  'customer_advances',
  'vat_output',
  'vat_input',
  'inventory',
  'inventory_defective',
  'stock_adjustments',
  'write_off',
  'cash_over_short',
  'cash_in_safe',
  'opening_balance_equity',
] as const;
export type AccountLinkKey = (typeof ACCOUNT_LINK_KEYS)[number];

export interface AccountLink {
  key: AccountLinkKey;
  accountId: string;
  /** The kind of account this event needs (fixed). */
  requiredType: AccountType;
  needsControl: boolean;
  rowVersion: number;
}

export interface AccountsResponse {
  accounts: AccountItem[];
  links: AccountLink[];
}

export const CreateAccountRequest = z.object({
  code: Code,
  nameAr: Name,
  nameEn: Name,
  accountType: z.enum(ACCOUNT_TYPES),
  parentId: IdText.nullable(),
  isPostable: z.boolean(),
  isControl: z.boolean().default(false),
  isContra: z.boolean().default(false),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>;

export const UpdateAccountRequest = CreateAccountRequest.extend({ rowVersion: RowVersion });
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequest>;

export const UpdateAccountLinkRequest = z.object({ accountId: IdText, rowVersion: RowVersion });
export type UpdateAccountLinkRequest = z.infer<typeof UpdateAccountLinkRequest>;

// ---------------------------------------------------------------------------------------------
// Lines of business
// ---------------------------------------------------------------------------------------------

export interface BusinessLineItem {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  revenueAccountId: string;
  cogsAccountId: string;
  sortOrder: number;
  isActive: boolean;
  rowVersion: number;
}

export const SaveBusinessLineFields = z.object({
  nameAr: Name,
  nameEn: Name,
  revenueAccountId: IdText,
  cogsAccountId: IdText,
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export const CreateBusinessLineRequest = SaveBusinessLineFields.extend({ code: Code });
export type CreateBusinessLineRequest = z.infer<typeof CreateBusinessLineRequest>;
export const UpdateBusinessLineRequest = SaveBusinessLineFields.extend({ rowVersion: RowVersion });
export type UpdateBusinessLineRequest = z.infer<typeof UpdateBusinessLineRequest>;

// ---------------------------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------------------------

export type PeriodStatus = 'open' | 'closed' | 'locked';

export interface PeriodItem {
  id: string;
  /** First and last day of the month (YYYY-MM-DD). */
  periodStart: string;
  periodEnd: string;
  fiscalYear: number;
  status: PeriodStatus;
  closedAt: string | null;
  closedByName: string | null;
  lockedAt: string | null;
  lockedByName: string | null;
  rowVersion: number;
}

export interface PeriodsResponse {
  periods: PeriodItem[];
  /** Today in Al Ain (YYYY-MM-DD): a month can be closed only after it ends. */
  today: string;
}

export const PeriodStepRequest = z.object({ rowVersion: RowVersion });
export type PeriodStepRequest = z.infer<typeof PeriodStepRequest>;

export const ReopenPeriodRequest = z.object({ reason: Reason, rowVersion: RowVersion });
export type ReopenPeriodRequest = z.infer<typeof ReopenPeriodRequest>;
