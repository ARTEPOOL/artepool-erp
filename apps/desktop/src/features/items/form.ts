/**
 * The item form as typed, and its conversion to the request the server expects. Prices travel as
 * 4-decimal whole-number text and quantities as thousandths (never floats); the checks here are
 * the same ones the server and the database apply again.
 */
import {
  BARCODE_PATTERN,
  CODE_PATTERN,
  fitsUnitDecimals,
  formatPrice,
  formatQuantity,
  MoneyFormatError,
  normalizeCode,
  parse4dp,
  parseQuantity,
} from '@artepool/shared';
import type {
  CreateItemRequest,
  ItemDetail,
  ItemType,
  UnitItem,
  UpdateItemRequest,
} from '@artepool/shared/contracts';

export interface BarcodeRow {
  key: string;
  barcode: string;
  qty: string;
  isPrimary: boolean;
}

export interface ComponentRow {
  key: string;
  itemId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  unitId: string;
  qty: string;
}

export interface ItemForm {
  itemType: ItemType;
  code: string;
  categoryId: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  unitId: string;
  vatCategoryId: string;
  businessLineId: string;
  isSellable: boolean;
  price: string;
  includesVat: boolean;
  /** Purchase price without VAT, as typed (owner only; decision 0038). */
  purchaseCost: string;
  barcodes: BarcodeRow[];
  components: ComponentRow[];
  reorderLevel: string;
  /** Stock items: the quantity on hand now (a new item's opening stock, or a correction). */
  openingQty: string;
}

/** The fields a message can be shown under (the same names the server uses). */
export type FormField =
  | 'itemType'
  | 'code'
  | 'categoryId'
  | 'nameAr'
  | 'nameEn'
  | 'unitId'
  | 'vatCategoryId'
  | 'price'
  | 'purchaseCost4dp'
  | 'barcodes'
  | 'components'
  | 'reorderLevelMilli'
  | 'openingQty';

/** Field → translation key of the message to show under it. */
export type FormErrors = Partial<Record<FormField, string>>;

export type ItemBody = Omit<CreateItemRequest, 'code'> & {
  stockOnHand?: UpdateItemRequest['stockOnHand'];
};

let counter = 0;
export const rowKey = (): string => `row-${++counter}`;

/** Thousandths → the quantity as a person types it ("5000" → "5", "2500" → "2.5"). */
export function quantityText(milli: string | null): string {
  if (milli === null) return '';
  const text = formatQuantity(BigInt(milli));
  return text.replace(/\.?0+$/, '');
}

/** A new item: stock item, standard VAT, for sale, price including VAT. */
export function emptyForm(defaults: { unitId: string; vatCategoryId: string }): ItemForm {
  return {
    itemType: 'stock',
    code: '',
    categoryId: '',
    nameAr: '',
    nameEn: '',
    descriptionAr: '',
    descriptionEn: '',
    unitId: defaults.unitId,
    vatCategoryId: defaults.vatCategoryId,
    businessLineId: '',
    isSellable: true,
    price: '',
    includesVat: true,
    purchaseCost: '',
    barcodes: [],
    components: [],
    reorderLevel: '',
    openingQty: '',
  };
}

export function formFromItem(item: ItemDetail): ItemForm {
  return {
    itemType: item.itemType,
    code: item.code,
    categoryId: item.categoryId,
    nameAr: item.nameAr,
    nameEn: item.nameEn,
    descriptionAr: item.descriptionAr ?? '',
    descriptionEn: item.descriptionEn ?? '',
    unitId: item.unitId,
    vatCategoryId: item.vatCategoryId,
    businessLineId: item.defaultBusinessLineId ?? '',
    isSellable: item.isSellable,
    price: item.price ? formatPrice(BigInt(item.price.price4dp)) : '',
    includesVat: item.price?.includesVat ?? true,
    // A kit's cost is worked out from its components, never typed.
    purchaseCost:
      item.itemType !== 'bundle' && item.purchaseCost4dp
        ? formatPrice(BigInt(item.purchaseCost4dp))
        : '',
    barcodes: item.barcodes.map((b) => ({
      key: rowKey(),
      barcode: b.barcode,
      qty: quantityText(b.qtyPerScanMilli),
      isPrimary: b.isPrimary,
    })),
    components: item.components.map((c) => ({
      key: rowKey(),
      itemId: c.itemId,
      code: c.code,
      nameAr: c.nameAr,
      nameEn: c.nameEn,
      unitId: c.unitId,
      qty: quantityText(c.quantityMilli),
    })),
    reorderLevel: quantityText(item.reorderLevelMilli),
    openingQty: item.stock ? quantityText(item.stock.onHandMilli) : '',
  };
}

/** The typed price in 4 decimals, or null when it is empty or not a valid amount. */
export function typedPrice(text: string): bigint | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const value = parse4dp(trimmed);
    return value >= 0n ? value : null;
  } catch (error) {
    if (error instanceof MoneyFormatError) return null;
    throw error;
  }
}

/** A typed quantity in thousandths, or null when it is not a valid number. */
function typedQuantity(text: string): bigint | null {
  try {
    return parseQuantity(text.trim());
  } catch (error) {
    if (error instanceof MoneyFormatError) return null;
    throw error;
  }
}

const DECIMALS_KEY = 'common:errors.rules.QUANTITY_DECIMALS';

/**
 * Checks the form and builds the request. `original` is the item being edited: when the person
 * may not change prices, its price is sent back unchanged.
 */
export function buildItem(
  form: ItemForm,
  options: {
    isNew: boolean;
    units: UnitItem[];
    canPrice: boolean;
    /** The owner (`items.cost`): the purchase price is part of the form and of the request. */
    canCost: boolean;
    /** A new stock item may come with its quantity on hand now (stock.opening). */
    canOpening?: boolean;
    /** Editing a stock item: its quantity may be corrected (stock.adjust), with this note. */
    canEditStock?: boolean;
    stockNote?: string;
    original?: ItemDetail;
  },
): { errors: FormErrors; body: ItemBody | null; code: string } {
  const errors: FormErrors = {};
  const required = 'masterdata:fields.required';
  const code = normalizeCode(form.code);
  if (options.isNew) {
    if (!code) errors.code = required;
    else if (!CODE_PATTERN.test(code)) errors.code = 'items:dialog.errors.code';
  }
  if (!form.categoryId) errors.categoryId = required;
  if (!form.nameAr.trim()) errors.nameAr = required;
  if (!form.nameEn.trim()) errors.nameEn = required;
  if (!form.unitId) errors.unitId = required;
  if (!form.vatCategoryId) errors.vatCategoryId = required;
  const unit = options.units.find((u) => u.id === form.unitId);

  // The one sale price (decision 0032).
  let price: ItemBody['price'] = null;
  if (options.canPrice) {
    const value = typedPrice(form.price);
    if (form.price.trim() && value === null) errors.price = 'items:dialog.errors.price';
    else if (form.isSellable && (value === null || value === 0n)) {
      errors.price = value === null ? required : 'masterdata:fields.too_small';
    } else if (value !== null) {
      price = { price4dp: value.toString(), includesVat: form.includesVat };
    }
  } else {
    price = options.original?.price ?? null;
    if (form.isSellable && !price) errors.price = 'items:dialog.errors.priceLocked';
  }

  // The purchase price, without VAT (decision 0038). Without `items.cost` it is left out of the
  // request, so the server keeps it; a kit never has one of its own.
  let purchaseCost4dp: ItemBody['purchaseCost4dp'];
  if (options.canCost) {
    if (form.itemType === 'bundle') purchaseCost4dp = null;
    else if (!form.purchaseCost.trim()) purchaseCost4dp = null;
    else {
      const value = typedPrice(form.purchaseCost);
      if (value === null) errors.purchaseCost4dp = 'items:dialog.errors.price';
      else purchaseCost4dp = value.toString();
    }
  }

  // Barcodes: empty rows are ignored; one main barcode (the first, if none is marked).
  const rows = form.barcodes.filter((b) => b.barcode.trim() !== '');
  const barcodes: ItemBody['barcodes'] = [];
  for (const row of rows) {
    const barcode = row.barcode.trim();
    const qty = typedQuantity(row.qty || '1');
    if (!BARCODE_PATTERN.test(barcode)) errors.barcodes = 'items:dialog.errors.barcode';
    else if (qty === null || qty <= 0n) errors.barcodes = 'items:dialog.errors.perScan';
    else barcodes.push({ barcode, qtyPerScanMilli: qty.toString(), isPrimary: row.isPrimary });
  }
  const upper = barcodes.map((b) => b.barcode.toUpperCase());
  if (!errors.barcodes && new Set(upper).size !== upper.length) {
    errors.barcodes = 'masterdata:fields.duplicate';
  }
  if (barcodes.length > 0 && !barcodes.some((b) => b.isPrimary)) barcodes[0]!.isPrimary = true;

  // Kits: what one kit is made of.
  const components: ItemBody['components'] = [];
  if (form.itemType === 'bundle') {
    if (form.components.length === 0) errors.components = 'items:dialog.errors.components';
    for (const row of form.components) {
      const qty = typedQuantity(row.qty);
      const decimals = options.units.find((u) => u.id === row.unitId)?.decimals ?? 3;
      if (qty === null || qty <= 0n) errors.components = 'items:dialog.errors.quantity';
      else if (!fitsUnitDecimals(qty, decimals)) errors.components = DECIMALS_KEY;
      else components.push({ itemId: row.itemId, quantityMilli: qty.toString() });
    }
  }

  // Stock items: the reorder level, in the unit's decimals.
  let reorderLevelMilli: string | null = null;
  if (form.itemType === 'stock' && form.reorderLevel.trim()) {
    const qty = typedQuantity(form.reorderLevel);
    if (qty === null || qty < 0n) errors.reorderLevelMilli = 'masterdata:fields.invalid_number';
    else if (unit && !fitsUnitDecimals(qty, unit.decimals)) errors.reorderLevelMilli = DECIMALS_KEY;
    else reorderLevelMilli = qty.toString();
  }
  // The quantity on hand now (new stock items only): posted as the item's opening stock.
  let openingStock: ItemBody['openingStock'];
  if (options.isNew && options.canOpening && form.itemType === 'stock' && form.openingQty.trim()) {
    const qty = typedQuantity(form.openingQty);
    if (qty === null || qty <= 0n) errors.openingQty = 'masterdata:fields.invalid_number';
    else if (unit && !fitsUnitDecimals(qty, unit.decimals)) errors.openingQty = DECIMALS_KEY;
    if (qty !== null && qty > 0n) openingStock = { quantityMilli: qty.toString() };
  }
  // Editing: a changed quantity becomes a stock adjustment on the server (from what was shown).
  let stockOnHand: ItemBody['stockOnHand'];
  const shown = options.original?.stock?.onHandMilli;
  if (!options.isNew && options.canEditStock && form.itemType === 'stock' && shown !== undefined) {
    const qty = form.openingQty.trim() ? typedQuantity(form.openingQty) : null;
    if (qty === null || qty < 0n) errors.openingQty = 'masterdata:fields.invalid_number';
    else if (unit && !fitsUnitDecimals(qty, unit.decimals)) errors.openingQty = DECIMALS_KEY;
    else if (qty !== BigInt(shown))
      stockOnHand = {
        quantityMilli: qty.toString(),
        expectedMilli: shown,
        note: options.stockNote ?? 'Item window',
      };
  }
  const reorderQtyMilli =
    form.itemType === 'stock' ? (options.original?.reorderQtyMilli ?? null) : null;

  if (Object.keys(errors).length > 0) return { errors, body: null, code };
  return {
    errors,
    code,
    body: {
      itemType: form.itemType,
      nameAr: form.nameAr.trim(),
      nameEn: form.nameEn.trim(),
      descriptionAr: form.descriptionAr.trim() || null,
      descriptionEn: form.descriptionEn.trim() || null,
      categoryId: form.categoryId,
      unitId: form.unitId,
      vatCategoryId: form.vatCategoryId,
      defaultBusinessLineId: form.businessLineId || null,
      reorderLevelMilli,
      reorderQtyMilli,
      isSellable: form.isSellable,
      price,
      ...(purchaseCost4dp === undefined ? {} : { purchaseCost4dp }),
      barcodes,
      components,
      ...(openingStock ? { openingStock } : {}),
      ...(stockOnHand ? { stockOnHand } : {}),
    },
  };
}
