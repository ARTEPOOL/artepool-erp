/**
 * Stock pieces shared by the list, the stock card and the adjustment dialog. Quantities travel as
 * thousandths (whole-number text) and are never floats; the stock itself is never edited: an
 * adjustment document (ADJ-…) is recorded and the stock is calculated from its movements.
 */
import { fitsUnitDecimals, MoneyFormatError, parseQuantity } from '@artepool/shared';
import type {
  CreateAdjustmentRequest,
  ReasonCategory,
  StockBalance,
} from '@artepool/shared/contracts';
import { quantityText, typedPrice } from './form';

/** What the person chooses in the dialog: "Counted quantity" becomes an increase or a decrease. */
export type Operation = 'counted' | 'increase' | 'decrease' | 'status_change' | 'write_off';
export const OPERATIONS: readonly Operation[] = [
  'counted',
  'increase',
  'decrease',
  'status_change',
  'write_off',
];
type SentKind = Exclude<Operation, 'counted'>;

/** The permission each operation needs (the server checks it again; decisions 0015, 0042). */
export const OPERATION_PERMISSION: Record<Operation, string> = {
  counted: 'stock.adjust',
  increase: 'stock.adjust',
  decrease: 'stock.adjust',
  status_change: 'stock.defective',
  write_off: 'stock.write_off',
};

/** The reason list each kind of adjustment takes its reason from. */
export const REASON_CATEGORY: Record<SentKind, ReasonCategory> = {
  increase: 'stock_increase',
  decrease: 'stock_decrease',
  status_change: 'defective',
  write_off: 'write_off',
};

/** May the person open the adjustment dialog at all? */
export const canAdjustAny = (can: (permission: string) => boolean): boolean =>
  OPERATIONS.some((op) => can(OPERATION_PERMISSION[op]));

/** A typed quantity in thousandths, or null when it is not a valid number. */
export function typedQuantity(text: string): bigint | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return parseQuantity(trimmed);
  } catch (error) {
    if (error instanceof MoneyFormatError) return null;
    throw error;
  }
}

/** Sellable and defective quantities (and book values) over all warehouses. */
export function totals(balances: StockBalance[]) {
  const sum = (
    status: StockBalance['stockStatus'],
    pick: (b: StockBalance) => string | undefined,
  ) =>
    balances
      .filter((b) => b.stockStatus === status)
      .reduce<bigint | null>((n, b) => {
        const value = pick(b);
        return value === undefined ? n : (n ?? 0n) + BigInt(value);
      }, null);
  const available = balances.find((b) => b.stockStatus === 'available');
  return {
    onHandMilli: sum('available', (b) => b.quantityMilli) ?? 0n,
    defectiveMilli: sum('defective', (b) => b.quantityMilli) ?? 0n,
    onHandValueFils: sum('available', (b) => b.bookValueFils),
    defectiveValueFils: sum('defective', (b) => b.bookValueFils),
    avgUnitCost4dp: available?.avgUnitCost4dp ?? null,
  };
}

/** A signed quantity with its sign always written (+3 / −3), so colour is never the only cue. */
export function signedQuantity(milli: bigint): string {
  if (milli === 0n) return '0';
  const abs = milli < 0n ? -milli : milli;
  return `${milli < 0n ? '−' : '+'}${quantityText(abs.toString())}`;
}

export interface AdjustForm {
  operation: Operation;
  quantity: string;
  reasonCodeId: string;
  note: string;
  unitCost: string;
}

export type AdjustField = 'quantity' | 'reasonCodeId' | 'note' | 'unitCost';
/** Field → translation key of the message to show under it. */
export type AdjustErrors = Partial<Record<AdjustField, string>>;

/** The kind actually sent: a counted quantity becomes the difference (null: no difference yet). */
export function effectiveKind(
  operation: Operation,
  quantityMilli: bigint | null,
  onHandMilli: bigint,
): { kind: SentKind | null; lineMilli: bigint | null } {
  if (operation !== 'counted') return { kind: operation, lineMilli: quantityMilli };
  if (quantityMilli === null) return { kind: null, lineMilli: null };
  const diff = quantityMilli - onHandMilli;
  if (diff === 0n) return { kind: null, lineMilli: 0n };
  return { kind: diff > 0n ? 'increase' : 'decrease', lineMilli: diff > 0n ? diff : -diff };
}

const DECIMALS_KEY = 'common:errors.rules.QUANTITY_DECIMALS';

/**
 * Checks the form and builds the request. `canCost`: the person holds `stock.view_cost`; without
 * it no unit cost is ever sent (the server uses the average cost or the purchase price).
 */
export function buildAdjustment(
  form: AdjustForm,
  options: {
    itemId: string;
    onHandMilli: bigint;
    unitDecimals: number;
    canCost: boolean;
    reasons: { id: string; category: ReasonCategory; requiresNote: boolean }[];
  },
): { errors: AdjustErrors; body: CreateAdjustmentRequest | null } {
  const errors: AdjustErrors = {};
  const qty = typedQuantity(form.quantity);
  const minimum = form.operation === 'counted' ? 0n : 1n;
  if (form.quantity.trim() === '') errors.quantity = 'masterdata:fields.required';
  else if (qty === null || qty < minimum) errors.quantity = 'items:adjust.errors.quantity';
  else if (!fitsUnitDecimals(qty, options.unitDecimals)) errors.quantity = DECIMALS_KEY;

  const { kind, lineMilli } = effectiveKind(form.operation, qty, options.onHandMilli);
  if (!errors.quantity && kind === null) errors.quantity = 'items:adjust.errors.noDifference';

  const reason = kind
    ? options.reasons.find(
        (r) => r.id === form.reasonCodeId && r.category === REASON_CATEGORY[kind],
      )
    : undefined;
  if (!reason) errors.reasonCodeId = 'masterdata:fields.required';
  const note = form.note.trim();
  if (reason?.requiresNote && !note) errors.note = 'items:adjust.errors.noteRequired';

  let unitCost4dp: string | undefined;
  if (options.canCost && kind === 'increase' && form.unitCost.trim()) {
    const value = typedPrice(form.unitCost);
    if (value === null) errors.unitCost = 'items:dialog.errors.price';
    else unitCost4dp = value.toString();
  }

  if (Object.keys(errors).length > 0 || !kind || !reason || lineMilli === null) {
    return { errors, body: null };
  }
  return {
    errors,
    body: {
      kind,
      reasonCodeId: reason.id,
      ...(note ? { note } : {}),
      lines: [
        {
          itemId: options.itemId,
          quantityMilli: lineMilli.toString(),
          ...(unitCost4dp === undefined ? {} : { unitCost4dp }),
        },
      ],
    },
  };
}
