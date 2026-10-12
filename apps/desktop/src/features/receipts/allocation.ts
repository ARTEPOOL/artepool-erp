/**
 * How a payment is spread over what the customer owes (decision 0052), in exact integers (fils),
 * the same way the server does it: the oldest debt first, or the amounts the person chose; what
 * settles nothing becomes an advance with its own payment tax invoice (decision 0013), whose VAT
 * is inside the amount. These are previews: the server works out the saved figures.
 */
import { MoneyFormatError, parseFils, vatInGross } from '@artepool/shared';
import type { DocType, DocumentItem, OpeningBalanceItem } from '@artepool/shared/contracts';

/** One thing the customer still owes: an issued invoice or debit note, or the opening balance. */
export interface OpenDebt {
  key: string;
  documentId: string | null;
  openingBalanceId: string | null;
  docNumber: string | null;
  docType: DocType | 'opening_balance';
  date: string | null;
  totalFils: bigint;
  dueFils: bigint;
}

const byOldest = (a: DocumentItem, b: DocumentItem): number => {
  const da = a.issueDate ?? '';
  const db = b.issueDate ?? '';
  if (da !== db) return da < db ? -1 : 1;
  const ia = BigInt(a.id);
  const ib = BigInt(b.id);
  return ia === ib ? 0 : ia < ib ? -1 : 1;
};

/** The open debts, oldest first: the opening balance, then documents by issue date (0052). */
export function debtsFrom(
  documents: DocumentItem[],
  opening: OpeningBalanceItem | null,
): OpenDebt[] {
  const debts: OpenDebt[] = [];
  if (opening && opening.direction === 'receivable') {
    const due = BigInt(opening.amountFils) - BigInt(opening.settledFils);
    if (due > 0n) {
      debts.push({
        key: `ob:${opening.id}`,
        documentId: null,
        openingBalanceId: opening.id,
        docNumber: opening.reference,
        docType: 'opening_balance',
        date: opening.balanceDate,
        totalFils: BigInt(opening.amountFils),
        dueFils: due,
      });
    }
  }
  const open = documents
    .filter(
      (d) =>
        d.status === 'issued' &&
        (d.docType === 'invoice' || d.docType === 'debit_note') &&
        d.settlementStatus !== 'settled',
    )
    .sort(byOldest);
  for (const d of open) {
    const due = BigInt(d.totalFils) - BigInt(d.settledFils);
    if (due <= 0n) continue;
    debts.push({
      key: `doc:${d.id}`,
      documentId: d.id,
      openingBalanceId: null,
      docNumber: d.docNumber,
      docType: d.docType,
      date: d.issueDate,
      totalFils: BigInt(d.totalFils),
      dueFils: due,
    });
  }
  return debts;
}

export type AmountProblem = 'required' | 'invalid' | 'zero';
export type AmountRead = { ok: true; value: bigint } | { ok: false; problem: AmountProblem };

/** A typed amount in AED → fils (Arabic digits accepted, at most 2 decimals, more than zero). */
export function readFils(text: string): AmountRead {
  const trimmed = text.trim().replace(/,/g, '');
  if (!trimmed) return { ok: false, problem: 'required' };
  let value: bigint;
  try {
    value = parseFils(trimmed);
  } catch (error) {
    if (error instanceof MoneyFormatError) return { ok: false, problem: 'invalid' };
    throw error;
  }
  if (value < 0n) return { ok: false, problem: 'invalid' };
  if (value === 0n) return { ok: false, problem: 'zero' };
  return { ok: true, value };
}

export interface Share {
  debt: OpenDebt;
  amountFils: bigint;
}

export interface Spread {
  shares: Share[];
  settledFils: bigint;
  /** What settles nothing: an advance with its own payment tax invoice. */
  advanceFils: bigint;
}

/** Automatic: the oldest debts first, each up to what is due; the rest is an advance. */
export function autoSpread(amountFils: bigint, debts: OpenDebt[]): Spread {
  let left = amountFils;
  const shares: Share[] = [];
  for (const debt of debts) {
    if (left === 0n) break;
    const share = debt.dueFils < left ? debt.dueFils : left;
    shares.push({ debt, amountFils: share });
    left -= share;
  }
  return { shares, settledFils: amountFils - left, advanceFils: left };
}

export type ShareProblem = 'invalid' | 'more_than_due';

/**
 * Manual: the amounts typed per debt. Each is at most what is due; together they are at most the
 * payment (`over` otherwise); the rest is an advance.
 */
export function manualSpread(
  amountFils: bigint,
  debts: OpenDebt[],
  typed: Readonly<Record<string, string>>,
): { spread: Spread; problems: Record<string, ShareProblem>; over: boolean } {
  const shares: Share[] = [];
  const problems: Record<string, ShareProblem> = {};
  let settled = 0n;
  for (const debt of debts) {
    const text = typed[debt.key]?.trim() ?? '';
    if (!text) continue;
    const read = readFils(text);
    if (!read.ok) {
      if (read.problem !== 'zero') problems[debt.key] = 'invalid';
      continue;
    }
    if (read.value > debt.dueFils) {
      problems[debt.key] = 'more_than_due';
      continue;
    }
    shares.push({ debt, amountFils: read.value });
    settled += read.value;
  }
  const over = settled > amountFils;
  return {
    spread: { shares, settledFils: settled, advanceFils: over ? 0n : amountFils - settled },
    problems,
    over,
  };
}

/** The VAT inside an advance (decision 0013): amount × rate ÷ (100% + rate), to the fils. */
export const advanceVat = (grossFils: bigint, rateBp: number): bigint =>
  vatInGross(grossFils, BigInt(rateBp));
