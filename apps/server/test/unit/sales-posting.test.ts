/** Golden tests for the sales rows of the posting map (1–11, 20): which side each amount goes. */
import { describe, expect, it } from 'vitest';
import type { PostingAmount } from '../../src/modules/ledger/posting';
import {
  documentPosting,
  openingBalancePosting,
  paymentPosting,
  type PostingLine,
} from '../../src/modules/ledger/sales-posting';

const REVENUE = 4100n;
const COGS = 5100n;
const CASH = 1120n;
const C = 7n;

const name = (a: PostingAmount) => (typeof a.link === 'string' ? a.link : `#${a.link.accountId}`);
const sides = (amounts: PostingAmount[]) => {
  const out: Record<string, bigint> = {};
  for (const a of amounts) if (a.fils !== 0n) out[name(a)] = (out[name(a)] ?? 0n) + a.fils;
  return out;
};
const balanced = (amounts: PostingAmount[]) => amounts.reduce((s, a) => s + a.fils, 0n) === 0n;

const item = (
  net: bigint,
  cost = 0n,
  ret: PostingLine['returnStockStatus'] = null,
): PostingLine => ({
  kind: 'item',
  netFils: net,
  businessLineId: 1n,
  revenueAccountId: REVENUE,
  cogsAccountId: COGS,
  costFils: cost,
  returnStockStatus: ret,
});
const advance = (kind: 'advance' | 'advance_deduction', net: bigint): PostingLine => ({
  kind,
  netFils: net,
  businessLineId: 1n,
  revenueAccountId: REVENUE,
  cogsAccountId: COGS,
  costFils: 0n,
});

describe('sales postings', () => {
  it('rows 1–2 — a sale: Receivable / Revenue (net) + VAT; Cost of sales / Inventory', () => {
    const a = documentPosting({
      docType: 'invoice',
      customerId: C,
      totalFils: 10_500n,
      vatFils: 500n,
      lines: [item(10_000n, 6_000n)],
    });
    expect(balanced(a)).toBe(true);
    expect(sides(a)).toEqual({
      ar_control: 10_500n,
      vat_output: -500n,
      [`#${REVENUE}`]: -10_000n,
      [`#${COGS}`]: 6_000n,
      inventory: -6_000n,
    });
    expect(a.find((x) => x.link === 'ar_control')!.customerId).toBe(C);
  });

  it('row 4 — a payment invoice: Receivable / Customer advances (net) + VAT', () => {
    const a = documentPosting({
      docType: 'advance_invoice',
      customerId: C,
      totalFils: 3_150_000n,
      vatFils: 150_000n,
      lines: [advance('advance', 3_000_000n)],
    });
    expect(sides(a)).toEqual({
      ar_control: 3_150_000n,
      vat_output: -150_000n,
      customer_advances: -3_000_000n,
    });
  });

  it('row 6 — the final invoice (0013): full revenue, advances released, only the VAT not yet charged', () => {
    const a = documentPosting({
      docType: 'invoice',
      customerId: C,
      totalFils: 3_150_000n,
      vatFils: 150_000n,
      lines: [
        item(10_000_000n),
        advance('advance_deduction', -3_000_000n),
        advance('advance_deduction', -4_000_000n),
      ],
    });
    expect(balanced(a)).toBe(true);
    expect(sides(a)).toEqual({
      ar_control: 3_150_000n,
      customer_advances: 7_000_000n,
      [`#${REVENUE}`]: -10_000_000n,
      vat_output: -150_000n,
    });
  });

  it('rows 7–8 — a credit note with goods back: the reverse, goods back at their cost (defective apart)', () => {
    const a = documentPosting({
      docType: 'credit_note',
      customerId: C,
      totalFils: 21_000n,
      vatFils: 1_000n,
      lines: [item(10_000n, 6_000n, 'available'), item(10_000n, 6_000n, 'defective')],
    });
    expect(balanced(a)).toBe(true);
    expect(sides(a)).toEqual({
      ar_control: -21_000n,
      vat_output: 1_000n,
      [`#${REVENUE}`]: 20_000n,
      [`#${COGS}`]: -12_000n,
      inventory: 6_000n,
      inventory_defective: 6_000n,
    });
  });

  it('row 9 — a credit note on a payment invoice: Customer advances + VAT / Receivable', () => {
    const a = documentPosting({
      docType: 'credit_note',
      customerId: C,
      totalFils: 1_050_000n,
      vatFils: 50_000n,
      lines: [advance('advance', 1_000_000n)],
    });
    expect(sides(a)).toEqual({
      ar_control: -1_050_000n,
      vat_output: 50_000n,
      customer_advances: 1_000_000n,
    });
  });

  it('rows 3, 5, 10, 11 — money in, money out, and a bounced cheque', () => {
    const receipt = paymentPosting({
      kind: 'receipt',
      customerId: C,
      amountFils: 500n,
      methodAccountId: CASH,
    });
    expect(sides(receipt)).toEqual({ [`#${CASH}`]: 500n, ar_control: -500n });
    const refund = paymentPosting({
      kind: 'refund',
      customerId: C,
      amountFils: 500n,
      methodAccountId: CASH,
    });
    expect(sides(refund)).toEqual({ [`#${CASH}`]: -500n, ar_control: 500n });
    const bounced = paymentPosting({
      kind: 'reversal',
      reversedKind: 'receipt',
      customerId: C,
      amountFils: 500n,
      methodAccountId: CASH,
    });
    expect(sides(bounced)).toEqual({ [`#${CASH}`]: -500n, ar_control: 500n });
  });

  it('row 20 — opening balances: Receivable / Opening balance equity (or the reverse)', () => {
    expect(
      sides(openingBalancePosting({ customerId: C, direction: 'receivable', amountFils: 900n })),
    ).toEqual({
      ar_control: 900n,
      opening_balance_equity: -900n,
    });
    expect(
      sides(openingBalancePosting({ customerId: C, direction: 'payable', amountFils: 900n })),
    ).toEqual({
      ar_control: -900n,
      opening_balance_equity: 900n,
    });
  });
});
