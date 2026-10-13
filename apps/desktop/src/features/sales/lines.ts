/**
 * The line editor's model: what the person typed, read into exact integers, and a preview of the
 * amounts with the same shared helper the server and the database use (decisions 0009, 0012).
 * The saved document's amounts always come from the server.
 */
import {
  allocateDocumentDiscount,
  computeLine,
  fitsUnitDecimals,
  format4dp,
  formatFils,
  formatQuantity,
  lineAmountFils,
  MoneyFormatError,
  parse4dp,
  parseFils,
  parseQuantity,
  roundDiv,
} from '@artepool/shared';
import type { ItemListItem, SalesLine, SalesLineInput } from '@artepool/shared/contracts';

export interface EditorLine {
  key: string;
  itemId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  unitId: string;
  vatCategoryId: string;
  listPrice4dp: string;
  includesVat: boolean;
  quantity: string;
  /** Empty = the item's price. */
  unitPrice: string;
  discountMode: 'percent' | 'amount';
  discount: string;
  optional: boolean;
  /** An invoice line converted from a quotation: it keeps the agreed price (decision 0049). */
  quotationLineId?: string;
}

export type LineProblem = 'quantity' | 'decimals' | 'price' | 'discount';

let next = 0;
export const newKey = () => `line-${Date.now()}-${(next += 1)}`;

export function lineFromItem(item: ItemListItem): EditorLine {
  return {
    key: newKey(),
    itemId: item.id,
    code: item.code,
    nameAr: item.nameAr,
    nameEn: item.nameEn,
    unitId: item.unitId,
    vatCategoryId: item.vatCategoryId,
    listPrice4dp: item.price?.price4dp ?? '0',
    includesVat: item.price?.includesVat ?? false,
    quantity: '1',
    unitPrice: '',
    discountMode: 'percent',
    discount: '',
    optional: false,
  };
}

/** A saved line back into the editor (editing a draft or a quotation). */
export function lineFromSaved(l: SalesLine, names: { nameAr: string; nameEn: string }): EditorLine {
  const qty = BigInt(l.quantityMilli);
  return {
    key: newKey(),
    itemId: l.itemId ?? '',
    code: l.itemCode ?? '',
    nameAr: names.nameAr,
    nameEn: names.nameEn,
    unitId: l.unitId ?? '',
    vatCategoryId: l.vatCategoryId,
    listPrice4dp: l.listPrice4dp,
    includesVat: l.priceIncludesVat,
    quantity: trimZeros(formatQuantity(qty)),
    unitPrice:
      l.unitPrice4dp === l.listPrice4dp ? '' : trimZeros(format4dp(BigInt(l.unitPrice4dp))),
    // A percentage stays a percentage (12.5% is 1250 basis points), so it follows the quantity.
    ...(l.lineDiscountBp != null && l.lineDiscountBp > 0
      ? {
          discountMode: 'percent' as const,
          discount: trimZeros(formatFils(BigInt(l.lineDiscountBp))),
        }
      : {
          discountMode: 'amount' as const,
          discount: BigInt(l.lineDiscountFils) === 0n ? '' : formatFils(BigInt(l.lineDiscountFils)),
        }),
    optional: l.isOptional ?? false,
    ...(l.quotationLineId ? { quotationLineId: l.quotationLineId } : {}),
  };
}

/** "2.500" → "2.5", "3.000" → "3". */
const trimZeros = (text: string) => (text.includes('.') ? text.replace(/\.?0+$/, '') : text);

const tryParse = (fn: (s: string) => bigint, text: string): bigint | null => {
  try {
    return fn(text.trim());
  } catch (error) {
    if (error instanceof MoneyFormatError) return null;
    throw error;
  }
};

export interface ReadLine {
  quantity: bigint;
  unitPrice4dp: bigint;
  /** Discount in fils on the price's basis (the server receives the percentage itself). */
  lineDiscountFils: bigint;
  lineDiscountBp: number | null;
  amountFils: bigint;
}

/** Reads one line; problems are shown under the field. */
export function readLine(
  l: EditorLine,
  unitDecimals: number,
): { ok: true; value: ReadLine } | { ok: false; problem: LineProblem } {
  const quantity = tryParse(parseQuantity, l.quantity);
  if (quantity === null || quantity <= 0n) return { ok: false, problem: 'quantity' };
  if (!fitsUnitDecimals(quantity, unitDecimals)) return { ok: false, problem: 'decimals' };
  const unitPrice4dp =
    l.unitPrice.trim() === '' ? BigInt(l.listPrice4dp) : tryParse(parse4dp, l.unitPrice);
  if (unitPrice4dp === null || unitPrice4dp < 0n) return { ok: false, problem: 'price' };
  const amountFils = lineAmountFils(quantity, unitPrice4dp);
  let lineDiscountFils = 0n;
  let lineDiscountBp: number | null = null;
  if (l.discount.trim() !== '') {
    if (l.discountMode === 'percent') {
      // A percentage with up to 2 decimals is basis points: "12.5" → 1250.
      const bp = tryParse(parseFils, l.discount);
      if (bp === null || bp < 0n || bp > 10_000n) return { ok: false, problem: 'discount' };
      lineDiscountBp = Number(bp);
      lineDiscountFils = roundDiv(amountFils * bp, 10_000n);
    } else {
      const fils = tryParse(parseFils, l.discount);
      if (fils === null || fils < 0n || fils > amountFils)
        return { ok: false, problem: 'discount' };
      lineDiscountFils = fils;
    }
  }
  return {
    ok: true,
    value: { quantity, unitPrice4dp, lineDiscountFils, lineDiscountBp, amountFils },
  };
}

export interface Preview {
  lines: ({ netFils: bigint; vatFils: bigint; grossFils: bigint; discountFils: bigint } | null)[];
  subtotalFils: bigint;
  discountFils: bigint;
  netFils: bigint;
  vatFils: bigint;
  totalFils: bigint;
  complete: boolean;
}

/** The amounts as the server will work them out (optional quotation lines are not counted). */
export function preview(
  lines: EditorLine[],
  docDiscountFils: bigint,
  unitDecimalsOf: (unitId: string) => number,
  rateOf: (vatCategoryId: string) => number | undefined,
): Preview {
  const read = lines.map((l) => readLine(l, unitDecimalsOf(l.unitId)));
  const weights = read.map((r, i) =>
    r.ok && !lines[i]!.optional ? r.value.amountFils - r.value.lineDiscountFils : 0n,
  );
  const totalWeight = weights.reduce((s, w) => s + w, 0n);
  const shares =
    docDiscountFils > 0n && docDiscountFils <= totalWeight
      ? allocateDocumentDiscount(docDiscountFils, weights)
      : weights.map(() => 0n);
  const out: Preview = {
    lines: [],
    subtotalFils: 0n,
    discountFils: 0n,
    netFils: 0n,
    vatFils: 0n,
    totalFils: 0n,
    complete: docDiscountFils <= totalWeight,
  };
  read.forEach((r, i) => {
    const rate = rateOf(lines[i]!.vatCategoryId);
    if (!r.ok || rate === undefined) {
      out.lines.push(null);
      out.complete = false;
      return;
    }
    const share = shares[i] ?? 0n;
    const amounts = computeLine({
      quantity: r.value.quantity,
      unitPrice4dp: r.value.unitPrice4dp,
      pricesIncludeVat: lines[i]!.includesVat,
      vatRateBp: BigInt(rate),
      lineDiscountFils: r.value.lineDiscountFils,
      docDiscountAllocFils: share,
    });
    out.lines.push({
      netFils: amounts.netFils,
      vatFils: amounts.vatFils,
      grossFils: amounts.grossFils,
      discountFils: r.value.lineDiscountFils + share,
    });
    if (lines[i]!.optional) return;
    out.subtotalFils += amounts.amountBeforeDiscountFils;
    out.discountFils += r.value.lineDiscountFils + share;
    out.netFils += amounts.netFils;
    out.vatFils += amounts.vatFils;
    out.totalFils += amounts.grossFils;
  });
  return out;
}

/** The lines as the server expects them; null when a line still has a problem. */
export function toRequest(
  lines: EditorLine[],
  unitDecimalsOf: (unitId: string) => number,
): SalesLineInput[] | null {
  const out: SalesLineInput[] = [];
  for (const l of lines) {
    const r = readLine(l, unitDecimalsOf(l.unitId));
    if (!r.ok) return null;
    out.push({
      itemId: l.itemId,
      quantityMilli: r.value.quantity.toString(),
      ...(l.unitPrice.trim() !== '' ? { unitPrice4dp: r.value.unitPrice4dp.toString() } : {}),
      ...(r.value.lineDiscountBp !== null
        ? { lineDiscountBp: r.value.lineDiscountBp }
        : r.value.lineDiscountFils > 0n
          ? { lineDiscountFils: r.value.lineDiscountFils.toString() }
          : {}),
      ...(l.optional ? { isOptional: true } : {}),
      ...(l.quotationLineId ? { quotationLineId: l.quotationLineId } : {}),
    });
  }
  return out;
}

/** A typed document discount (fils); empty → 0, a bad value → null. */
export function readDocDiscount(text: string): bigint | null {
  if (text.trim() === '') return 0n;
  const v = tryParse(parseFils, text);
  return v === null || v < 0n ? null : v;
}

export const priceChanged = (l: EditorLine): boolean => {
  if (l.unitPrice.trim() === '') return false;
  const p = tryParse(parse4dp, l.unitPrice);
  return p !== null && p !== BigInt(l.listPrice4dp);
};
