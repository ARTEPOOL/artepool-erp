/**
 * Settings → Company: the seller details printed on every tax invoice. Read by everyone signed
 * in; edited by the owner only (decision 0030). TRN 15 digits starting with 100; logo PNG or JPEG
 * up to 512 KB, recognised by its content (decision 0037).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { normalizePhone, normalizeTrn } from '@artepool/shared';
import {
  LOGO_MAX_BYTES,
  type CompanyProfile,
  type Emirate,
  type LogoResponse,
  type LogoType,
  type SaveCompanyRequest,
  type SaveLogoRequest,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { expectUpdated, fieldError } from '../../platform/db/versioned';
import { AppError, ruleError } from '../../platform/errors/app-error';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function getCompany(db: Kysely<DB>): Promise<CompanyProfile | null> {
  const row = await db
    .selectFrom('sys.company_profile')
    .selectAll()
    .where('id', '=', 1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    legalNameAr: row.legal_name_ar,
    legalNameEn: row.legal_name_en,
    tradeNameAr: row.trade_name_ar,
    tradeNameEn: row.trade_name_en,
    vatRegistered: row.vat_registered,
    trn: row.trn,
    addressAr: row.address_ar,
    addressEn: row.address_en,
    city: row.city,
    poBox: row.po_box,
    phone: row.phone,
    email: row.email,
    website: row.website,
    emirate: row.emirate as Emirate | null,
    logoType: row.logo_mime as LogoType | null,
    currency: 'AED',
    rowVersion: row.row_version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function canEditCompany(db: Kysely<DB>, userId: bigint): Promise<boolean> {
  const { rows } = await sql<{ allowed: boolean }>`
    SELECT auth.user_has_permission(${userId}, 'system.company.edit') AS allowed`.execute(db);
  return rows[0]?.allowed ?? false;
}

export async function saveCompany(
  trx: Transaction<DB>,
  body: SaveCompanyRequest,
): Promise<CompanyProfile> {
  let trn: string | null = null;
  if (body.vatRegistered) {
    trn = body.trn ? normalizeTrn(body.trn) : null;
    if (!trn) throw fieldError('trn', 'invalid_trn');
  }
  let phone: string | null = null;
  if (body.phone) {
    phone = normalizePhone(body.phone);
    if (!phone) throw fieldError('phone', 'invalid_phone');
  }
  if (body.email && !EMAIL.test(body.email)) throw fieldError('email', 'invalid_email');

  const values = {
    legal_name_ar: body.legalNameAr,
    legal_name_en: body.legalNameEn,
    trade_name_ar: body.tradeNameAr ?? null,
    trade_name_en: body.tradeNameEn ?? null,
    vat_registered: body.vatRegistered,
    trn,
    address_ar: body.addressAr,
    address_en: body.addressEn,
    city: body.city ?? null,
    po_box: body.poBox ?? null,
    phone,
    email: body.email ?? null,
    website: body.website ?? null,
    emirate: body.emirate ?? null,
  };

  const exists = await trx
    .selectFrom('sys.company_profile')
    .select('id')
    .where('id', '=', 1)
    .executeTakeFirst();
  if (!exists) {
    await trx
      .insertInto('sys.company_profile')
      .values(stamped('sys.company_profile', { id: 1, ...values }))
      .execute();
  } else {
    if (body.rowVersion === undefined) {
      throw new AppError('STALE_VERSION', 'The company details were saved by someone else');
    }
    const result = await trx
      .updateTable('sys.company_profile')
      .set(values)
      .where('id', '=', 1)
      .where('row_version', '=', body.rowVersion)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw new AppError('STALE_VERSION', 'The company details were saved by someone else');
    }
  }
  return (await getCompany(trx))!;
}

/** What a logo file really is, from its first bytes (never from its name). */
export function detectImageType(bytes: Buffer): LogoType | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

export async function saveLogo(
  trx: Transaction<DB>,
  body: SaveLogoRequest,
): Promise<CompanyProfile> {
  let logo: Buffer | null = null;
  let type: LogoType | null = null;
  if (body.logo) {
    logo = Buffer.from(body.logo.dataBase64, 'base64');
    if (logo.length === 0 || logo.length > LOGO_MAX_BYTES) {
      throw ruleError('LOGO_INVALID', 'The logo must be a PNG or JPEG file of at most 512 KB');
    }
    type = detectImageType(logo);
    if (type !== body.logo.type) {
      throw ruleError('LOGO_INVALID', 'The logo file is not the PNG or JPEG image it claims to be');
    }
  }
  const result = await trx
    .updateTable('sys.company_profile')
    .set({ logo, logo_mime: type })
    .where('id', '=', 1)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'sys.company_profile', 1n, result);
  return (await getCompany(trx))!;
}

export async function getLogo(db: Kysely<DB>): Promise<LogoResponse> {
  const row = await db
    .selectFrom('sys.company_profile')
    .select(['logo', 'logo_mime'])
    .where('id', '=', 1)
    .executeTakeFirst();
  if (!row?.logo || !row.logo_mime) return { logo: null };
  return { logo: { type: row.logo_mime as LogoType, dataBase64: row.logo.toString('base64') } };
}
