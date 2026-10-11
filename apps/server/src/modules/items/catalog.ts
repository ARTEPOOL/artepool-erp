/** Settings → Lists: units and item categories (decision 0034). Deactivated with a reason. */
import type { Kysely, Transaction } from 'kysely';
import type {
  CategoryItem,
  CreateCategoryRequest,
  CreateUnitRequest,
  UnitItem,
  UpdateCategoryRequest,
  UpdateUnitRequest,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { expectUpdated } from '../../platform/db/versioned';
import { AppError } from '../../platform/errors/app-error';

export async function listUnits(db: Kysely<DB>): Promise<UnitItem[]> {
  const rows = await db.selectFrom('md.units').selectAll().orderBy('id').execute();
  return rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    decimals: r.decimals,
    einvoiceCode: r.einvoice_code,
    isActive: r.is_active,
    rowVersion: r.row_version,
  }));
}

async function oneUnit(db: Kysely<DB>, id: bigint): Promise<UnitItem> {
  const unit = (await listUnits(db)).find((u) => u.id === id.toString());
  if (!unit) throw new AppError('NOT_FOUND', 'No such unit');
  return unit;
}

export async function createUnit(trx: Transaction<DB>, body: CreateUnitRequest): Promise<UnitItem> {
  const row = await trx
    .insertInto('md.units')
    .values(
      stamped('md.units', {
        code: body.code.toUpperCase(),
        name_ar: body.nameAr,
        name_en: body.nameEn,
        decimals: body.decimals,
        einvoice_code: body.einvoiceCode?.toUpperCase() ?? null,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return oneUnit(trx, row.id);
}

export async function updateUnit(
  trx: Transaction<DB>,
  id: bigint,
  body: UpdateUnitRequest,
): Promise<UnitItem> {
  const result = await trx
    .updateTable('md.units')
    .set({
      name_ar: body.nameAr,
      name_en: body.nameEn,
      decimals: body.decimals,
      einvoice_code: body.einvoiceCode?.toUpperCase() ?? null,
    })
    .where('id', '=', id)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.units', id, result);
  return oneUnit(trx, id);
}

export async function setUnitActive(
  trx: Transaction<DB>,
  id: bigint,
  active: boolean,
  rowVersion: number,
): Promise<UnitItem> {
  const result = await trx
    .updateTable('md.units')
    .set({ is_active: active })
    .where('id', '=', id)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.units', id, result);
  return oneUnit(trx, id);
}

export async function listCategories(db: Kysely<DB>): Promise<CategoryItem[]> {
  const rows = await db
    .selectFrom('md.item_categories')
    .selectAll()
    .orderBy('sort_order')
    .orderBy('code')
    .execute();
  return rows.map((r) => ({
    id: r.id.toString(),
    parentId: r.parent_id?.toString() ?? null,
    code: r.code,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    sortOrder: r.sort_order,
    isActive: r.is_active,
    rowVersion: r.row_version,
  }));
}

async function oneCategory(db: Kysely<DB>, id: bigint): Promise<CategoryItem> {
  const category = (await listCategories(db)).find((c) => c.id === id.toString());
  if (!category) throw new AppError('NOT_FOUND', 'No such category');
  return category;
}

const categoryValues = (body: CreateCategoryRequest) => ({
  parent_id: body.parentId ? BigInt(body.parentId) : null,
  code: body.code.toUpperCase(),
  name_ar: body.nameAr,
  name_en: body.nameEn,
  sort_order: body.sortOrder,
});

export async function createCategory(
  trx: Transaction<DB>,
  body: CreateCategoryRequest,
): Promise<CategoryItem> {
  const row = await trx
    .insertInto('md.item_categories')
    .values(stamped('md.item_categories', categoryValues(body)))
    .returning('id')
    .executeTakeFirstOrThrow();
  return oneCategory(trx, row.id);
}

export async function updateCategory(
  trx: Transaction<DB>,
  id: bigint,
  body: UpdateCategoryRequest,
): Promise<CategoryItem> {
  const result = await trx
    .updateTable('md.item_categories')
    .set(categoryValues(body))
    .where('id', '=', id)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.item_categories', id, result);
  return oneCategory(trx, id);
}

export async function setCategoryActive(
  trx: Transaction<DB>,
  id: bigint,
  active: boolean,
  rowVersion: number,
): Promise<CategoryItem> {
  const result = await trx
    .updateTable('md.item_categories')
    .set({ is_active: active })
    .where('id', '=', id)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.item_categories', id, result);
  return oneCategory(trx, id);
}
