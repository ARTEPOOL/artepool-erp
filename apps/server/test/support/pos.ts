/**
 * Set-up for the POS screen tests (Playwright): the company details and stock items with a
 * barcode, a price and opening stock — created through the same services the screens use.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { saveCompany } from '../../src/modules/company/service';
import { createAdjustment } from '../../src/modules/inventory/service';
import { withBusinessTx } from '../../src/platform/db/tx';
import type { TestServer } from './server';

export async function addPosItem(
  server: TestServer,
  ownerId: bigint,
  item: {
    code: string;
    nameAr: string;
    nameEn: string;
    barcode: string;
    price4dp: string;
    quantityMilli: string;
  },
): Promise<{ id: string }> {
  return withBusinessTx(
    server.db,
    { userId: ownerId, requestId: randomUUID(), reason: 'e2e: POS item' },
    async (trx) => {
      const company = await trx.selectFrom('sys.company_profile').select('id').executeTakeFirst();
      if (!company) {
        await saveCompany(trx, {
          legalNameAr: 'آرتي بول لحمامات السباحة',
          legalNameEn: 'ARTEPOOL Swimming Pools',
          vatRegistered: true,
          trn: '100123456789012',
          addressAr: 'العين، أبوظبي',
          addressEn: 'Al Ain, Abu Dhabi',
        });
      }
      const { rows } = await sql<{ id: string }>`
        INSERT INTO md.items (code, item_type, name_ar, name_en, category_id, unit_id, vat_category_id,
                              fallback_unit_cost_4dp)
        VALUES (${item.code}, 'stock', ${item.nameAr}, ${item.nameEn},
                (SELECT id FROM md.item_categories WHERE code = 'CHEM'),
                (SELECT id FROM md.units WHERE code = 'PCS'),
                (SELECT id FROM md.vat_categories WHERE code = 'SR'), 50000)
        RETURNING id::text`.execute(trx);
      const id = rows[0]!.id;
      await sql`INSERT INTO md.item_prices (price_level_id, item_id, price_4dp, includes_vat)
                VALUES ((SELECT id FROM md.price_levels WHERE is_default), ${id}, ${item.price4dp}, true)`.execute(
        trx,
      );
      await sql`INSERT INTO md.item_barcodes (item_id, barcode, is_primary) VALUES (${id}, ${item.barcode}, true)`.execute(
        trx,
      );
      await createAdjustment(
        trx,
        { permissions: new Set(['stock.opening', 'stock.view_cost']) },
        {
          kind: 'opening',
          reasonCodeId: (
            await trx
              .selectFrom('sys.reason_codes')
              .select(sql<string>`id::text`.as('id'))
              .where('category', '=', 'other')
              .where('code', '=', 'OPENING')
              .executeTakeFirstOrThrow()
          ).id,
          lines: [{ itemId: id, quantityMilli: item.quantityMilli, unitCost4dp: '50000' }],
        },
      );
      return { id };
    },
  );
}
