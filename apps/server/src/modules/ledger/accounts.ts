/**
 * Accounting → Chart of accounts and the account used for each event (decisions 0018, 0035).
 * Provisional and editable until the accountant approves it. The database keeps the tree sound
 * and protects accounts in use; this service reads, writes and reports them.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  AccountItem,
  AccountLink,
  AccountLinkKey,
  AccountsResponse,
  AccountType,
  AccountUse,
  BusinessLineItem,
  CreateAccountRequest,
  CreateBusinessLineRequest,
  UpdateAccountLinkRequest,
  UpdateAccountRequest,
  UpdateBusinessLineRequest,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { expectUpdated } from '../../platform/db/versioned';
import { AppError } from '../../platform/errors/app-error';

export async function listAccounts(db: Kysely<DB>): Promise<AccountsResponse> {
  const rows = await db
    .selectFrom('gl.accounts')
    .select([
      'id',
      'code',
      'name_ar',
      'name_en',
      'account_type',
      'parent_id',
      'is_postable',
      'is_control',
      'is_contra',
      'is_active',
      'row_version',
      sql<string | null>`gl.account_in_use(id)`.as('in_use'),
    ])
    .orderBy('code')
    .execute();
  const links = await db
    .selectFrom('gl.account_mappings')
    .select(['key', 'account_id', 'required_type', 'needs_control', 'row_version'])
    .orderBy('key')
    .execute();
  return {
    accounts: rows.map((r): AccountItem => ({
      id: r.id.toString(),
      code: r.code,
      nameAr: r.name_ar,
      nameEn: r.name_en,
      accountType: r.account_type as AccountType,
      parentId: r.parent_id?.toString() ?? null,
      isPostable: r.is_postable,
      isControl: r.is_control,
      isContra: r.is_contra,
      isActive: r.is_active,
      inUse: r.in_use as AccountUse | null,
      rowVersion: r.row_version,
    })),
    links: links.map((l): AccountLink => ({
      key: l.key as AccountLinkKey,
      accountId: l.account_id.toString(),
      requiredType: l.required_type as AccountType,
      needsControl: l.needs_control,
      rowVersion: l.row_version,
    })),
  };
}

async function oneAccount(db: Kysely<DB>, id: bigint): Promise<AccountItem> {
  const account = (await listAccounts(db)).accounts.find((a) => a.id === id.toString());
  if (!account) throw new AppError('NOT_FOUND', 'No such account');
  return account;
}

const accountValues = (body: CreateAccountRequest) => ({
  code: body.code,
  name_ar: body.nameAr,
  name_en: body.nameEn,
  account_type: body.accountType,
  parent_id: body.parentId ? BigInt(body.parentId) : null,
  is_postable: body.isPostable,
  is_control: body.isPostable && body.isControl,
  is_contra: body.isContra,
});

export async function createAccount(
  trx: Transaction<DB>,
  body: CreateAccountRequest,
): Promise<AccountItem> {
  const row = await trx
    .insertInto('gl.accounts')
    .values(stamped('gl.accounts', accountValues(body)))
    .returning('id')
    .executeTakeFirstOrThrow();
  return oneAccount(trx, row.id);
}

export async function updateAccount(
  trx: Transaction<DB>,
  id: bigint,
  body: UpdateAccountRequest,
): Promise<AccountItem> {
  const result = await trx
    .updateTable('gl.accounts')
    .set(accountValues(body))
    .where('id', '=', id)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'gl.accounts', id, result);
  return oneAccount(trx, id);
}

export async function setAccountActive(
  trx: Transaction<DB>,
  id: bigint,
  active: boolean,
  rowVersion: number,
): Promise<AccountItem> {
  const result = await trx
    .updateTable('gl.accounts')
    .set({ is_active: active })
    .where('id', '=', id)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'gl.accounts', id, result);
  return oneAccount(trx, id);
}

export async function updateAccountLink(
  trx: Transaction<DB>,
  key: AccountLinkKey,
  body: UpdateAccountLinkRequest,
): Promise<AccountLink> {
  const result = await trx
    .updateTable('gl.account_mappings')
    .set({ account_id: BigInt(body.accountId) })
    .where('key', '=', key)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) {
    const exists = await trx
      .selectFrom('gl.account_mappings')
      .select('key')
      .where('key', '=', key)
      .executeTakeFirst();
    throw exists
      ? new AppError('STALE_VERSION', `Event link ${key} was changed by someone else`)
      : new AppError('NOT_FOUND', 'No such event link');
  }
  return (await listAccounts(trx)).links.find((l) => l.key === key)!;
}

// ---------------------------------------------------------------------------------------------
// Lines of business: each has its revenue and cost-of-sales account
// ---------------------------------------------------------------------------------------------

export async function listBusinessLines(db: Kysely<DB>): Promise<BusinessLineItem[]> {
  const rows = await db
    .selectFrom('md.business_lines')
    .selectAll()
    .orderBy('sort_order')
    .orderBy('code')
    .execute();
  return rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    revenueAccountId: r.revenue_account_id.toString(),
    cogsAccountId: r.cogs_account_id.toString(),
    sortOrder: r.sort_order,
    isActive: r.is_active,
    rowVersion: r.row_version,
  }));
}

async function oneBusinessLine(db: Kysely<DB>, id: bigint): Promise<BusinessLineItem> {
  const line = (await listBusinessLines(db)).find((l) => l.id === id.toString());
  if (!line) throw new AppError('NOT_FOUND', 'No such line of business');
  return line;
}

export async function createBusinessLine(
  trx: Transaction<DB>,
  body: CreateBusinessLineRequest,
): Promise<BusinessLineItem> {
  const row = await trx
    .insertInto('md.business_lines')
    .values(
      stamped('md.business_lines', {
        code: body.code,
        name_ar: body.nameAr,
        name_en: body.nameEn,
        revenue_account_id: BigInt(body.revenueAccountId),
        cogs_account_id: BigInt(body.cogsAccountId),
        sort_order: body.sortOrder,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return oneBusinessLine(trx, row.id);
}

export async function updateBusinessLine(
  trx: Transaction<DB>,
  id: bigint,
  body: UpdateBusinessLineRequest,
): Promise<BusinessLineItem> {
  const result = await trx
    .updateTable('md.business_lines')
    .set({
      name_ar: body.nameAr,
      name_en: body.nameEn,
      revenue_account_id: BigInt(body.revenueAccountId),
      cogs_account_id: BigInt(body.cogsAccountId),
      sort_order: body.sortOrder,
    })
    .where('id', '=', id)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.business_lines', id, result);
  return oneBusinessLine(trx, id);
}

export async function setBusinessLineActive(
  trx: Transaction<DB>,
  id: bigint,
  active: boolean,
  rowVersion: number,
): Promise<BusinessLineItem> {
  const result = await trx
    .updateTable('md.business_lines')
    .set({ is_active: active })
    .where('id', '=', id)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.business_lines', id, result);
  return oneBusinessLine(trx, id);
}
