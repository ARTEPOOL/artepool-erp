/**
 * The barcode label design (decision 0097): versions of the `barcode_label` print template. Everyone
 * who prints labels reads the current one; only the owner saves a new one (checked again by the
 * database). Versions are never changed or deleted; every save is in the audit log.
 */
import type { Kysely, Transaction } from 'kysely';
import {
  readLabelDesign,
  type LabelDesignResponse,
  type SaveLabelDesignRequest,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { filledByDatabase } from '../../platform/db/stamped';
import { AppError } from '../../platform/errors/app-error';

type Db = Kysely<DB> | Transaction<DB>;

export async function getLabelDesign(db: Db, canEdit: boolean): Promise<LabelDesignResponse> {
  const row = await db
    .selectFrom('sys.print_templates as t')
    .innerJoin('sys.print_template_versions as v', 'v.id', 't.current_version_id')
    .leftJoin('auth.users as u', 'u.id', 'v.created_by')
    .select([
      'v.id',
      'v.version_no',
      'v.settings',
      'v.created_at',
      'u.display_name_ar',
      'u.display_name_en',
    ])
    .where('t.doc_kind', '=', 'barcode_label')
    .executeTakeFirst();
  if (!row) throw new AppError('INTERNAL', 'No barcode label template');
  const company = await db
    .selectFrom('sys.company_profile')
    .select(['legal_name_ar', 'legal_name_en', 'trade_name_ar', 'trade_name_en'])
    .where('id', '=', 1)
    .executeTakeFirst();
  return {
    versionId: row.id.toString(),
    versionNo: row.version_no,
    savedAt: row.created_at.toISOString(),
    savedBy:
      row.display_name_ar || row.display_name_en
        ? { displayNameAr: row.display_name_ar ?? '', displayNameEn: row.display_name_en ?? '' }
        : null,
    design: readLabelDesign(row.settings),
    // The trade name when there is one, as on the shop's sign.
    shopName: {
      ar: company?.trade_name_ar || company?.legal_name_ar || '',
      en: company?.trade_name_en || company?.legal_name_en || '',
    },
    canEdit,
  };
}

/** A new version becomes the current design; refused when someone saved meanwhile. */
export async function saveLabelDesign(
  trx: Transaction<DB>,
  body: SaveLabelDesignRequest,
): Promise<LabelDesignResponse> {
  const template = await trx
    .selectFrom('sys.print_templates')
    .select(['id', 'current_version_id'])
    .where('doc_kind', '=', 'barcode_label')
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (template.current_version_id?.toString() !== body.basedOnVersionId) {
    throw new AppError('STALE_VERSION', 'The label design was saved by someone else meanwhile');
  }
  const version = await trx
    .insertInto('sys.print_template_versions')
    .values(
      // The version number is the next of its template, set by the database.
      filledByDatabase('sys.print_template_versions', {
        template_id: template.id,
        settings: JSON.stringify(body.design),
        note: body.note ?? null,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .updateTable('sys.print_templates')
    .set({ current_version_id: version.id })
    .where('id', '=', template.id)
    .execute();
  return getLabelDesign(trx, true);
}
