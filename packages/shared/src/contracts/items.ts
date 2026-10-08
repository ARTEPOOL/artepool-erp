/**
 * Items & stock (design 07), units, item categories and VAT categories. Each item has one sale
 * price with a "price includes VAT" switch (decision 0032); amounts travel as exact whole-number
 * text (prices in 4 decimals, quantities in thousandths).
 */
import { z } from 'zod';
import { BARCODE_PATTERN } from '../masterdata';
import { IdText } from './auth';
import {
  Code,
  ListQuery,
  Name,
  NonNegativeIntText,
  OptionalText,
  Reason,
  RowVersion,
} from './common';

// ---------------------------------------------------------------------------------------------
// VAT categories (decision 0033): four, fixed; only the owner changes a rate
// ---------------------------------------------------------------------------------------------

export type VatCode = 'SR' | 'ZR' | 'EX' | 'OS';

export interface VatCategoryItem {
  id: string;
  code: VatCode;
  nameAr: string;
  nameEn: string;
  rateBp: number;
  rowVersion: number;
}

export interface VatResponse {
  categories: VatCategoryItem[];
  /** E-invoicing go-live date, null while it waits for the accountant (decision 0019). */
  einvoiceMandatoryFrom: string | null;
}

export const UpdateVatRateRequest = z.object({
  rateBp: z.number().int().min(0).max(10_000),
  reason: Reason,
  rowVersion: RowVersion,
});
export type UpdateVatRateRequest = z.infer<typeof UpdateVatRateRequest>;

// ---------------------------------------------------------------------------------------------
// Units and categories
// ---------------------------------------------------------------------------------------------

export interface UnitItem {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  /** Decimals allowed in quantities: 0 for pieces, up to 3 for kilograms. */
  decimals: number;
  einvoiceCode: string | null;
  isActive: boolean;
  rowVersion: number;
}

const UnitFields = z.object({
  nameAr: Name,
  nameEn: Name,
  decimals: z.number().int().min(0).max(3),
  einvoiceCode: OptionalText(3),
});
export const CreateUnitRequest = UnitFields.extend({ code: Code });
export type CreateUnitRequest = z.infer<typeof CreateUnitRequest>;
export const UpdateUnitRequest = UnitFields.extend({ rowVersion: RowVersion });
export type UpdateUnitRequest = z.infer<typeof UpdateUnitRequest>;

export interface CategoryItem {
  id: string;
  parentId: string | null;
  code: string;
  nameAr: string;
  nameEn: string;
  sortOrder: number;
  isActive: boolean;
  rowVersion: number;
}

const CategoryFields = z.object({
  parentId: IdText.nullable(),
  code: Code,
  nameAr: Name,
  nameEn: Name,
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export const CreateCategoryRequest = CategoryFields;
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequest>;
export const UpdateCategoryRequest = CategoryFields.extend({ rowVersion: RowVersion });
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequest>;

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

export const ITEM_TYPES = ['stock', 'service', 'bundle'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export interface ItemPrice {
  /** 4 decimals as whole-number text: "125000" = 12.5000 AED. */
  price4dp: string;
  includesVat: boolean;
}

export interface ItemListItem {
  id: string;
  code: string;
  itemType: ItemType;
  nameAr: string;
  nameEn: string;
  categoryId: string;
  unitId: string;
  vatCategoryId: string;
  /** The Standard price; null when the item has none (not for sale). */
  price: ItemPrice | null;
  primaryBarcode: string | null;
  isSellable: boolean;
  isActive: boolean;
}

export const ItemsQuery = ListQuery.extend({
  categoryId: IdText.optional(),
  itemType: z.enum(ITEM_TYPES).optional(),
});
export type ItemsQuery = z.infer<typeof ItemsQuery>;

export interface ItemsResponse {
  items: ItemListItem[];
  total: number;
  /** Active items by type, for the summary tiles. */
  counts: { active: number; stock: number; service: number; bundle: number };
}

export interface BarcodeItem {
  id: string;
  barcode: string;
  /** Pack barcodes scan several units at once (thousandths). */
  qtyPerScanMilli: string;
  isPrimary: boolean;
}

export interface ComponentItem {
  itemId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  unitId: string;
  quantityMilli: string;
}

export interface ItemDetail extends ItemListItem {
  descriptionAr: string | null;
  descriptionEn: string | null;
  defaultBusinessLineId: string | null;
  reorderLevelMilli: string | null;
  reorderQtyMilli: string | null;
  barcodes: BarcodeItem[];
  components: ComponentItem[];
  /** Why the type can no longer change, if it cannot. */
  inUse: string | null;
  rowVersion: number;
}

const ItemFields = z.object({
  itemType: z.enum(ITEM_TYPES),
  nameAr: Name,
  nameEn: Name,
  descriptionAr: OptionalText(1000),
  descriptionEn: OptionalText(1000),
  categoryId: IdText,
  unitId: IdText,
  vatCategoryId: IdText,
  defaultBusinessLineId: IdText.nullable().default(null),
  reorderLevelMilli: NonNegativeIntText.nullable().default(null),
  reorderQtyMilli: NonNegativeIntText.nullable().default(null),
  isSellable: z.boolean().default(true),
  /** The one sale price (decision 0032). Required for items that are for sale. */
  price: z
    .object({ price4dp: NonNegativeIntText, includesVat: z.boolean() })
    .nullable()
    .default(null),
  barcodes: z
    .array(
      z.object({
        barcode: z.string().trim().regex(BARCODE_PATTERN),
        qtyPerScanMilli: NonNegativeIntText.default('1000'),
        isPrimary: z.boolean().default(false),
      }),
    )
    .max(20)
    .default([]),
  /** Kits only: what one kit is made of. */
  components: z
    .array(z.object({ itemId: IdText, quantityMilli: NonNegativeIntText }))
    .max(50)
    .default([]),
});

export const CreateItemRequest = ItemFields.extend({ code: Code });
export type CreateItemRequest = z.infer<typeof CreateItemRequest>;
export const UpdateItemRequest = ItemFields.extend({ rowVersion: RowVersion });
export type UpdateItemRequest = z.infer<typeof UpdateItemRequest>;

export const NextItemCodeQuery = z.object({ categoryId: IdText });
export interface NextItemCodeResponse {
  code: string;
}
