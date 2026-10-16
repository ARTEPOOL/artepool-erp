/**
 * Settings → Company → Bank accounts (decision 0065): several accounts, a UAE IBAN with its
 * checksum and an optional SWIFT code. Owner only (`system.company.edit`, checked again by the
 * database); deactivated with a reason, never deleted. Every change is in the audit log.
 */
import type { Kysely, Transaction } from 'kysely';
import { normalizeSwift, normalizeUaeIban } from '@artepool/shared';
import type { BankAccount, SaveBankAccountRequest } from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { expectUpdated, fieldError } from '../../platform/db/versioned';
import { AppError } from '../../platform/errors/app-error';

type Db = Kysely<DB> | Transaction<DB>;

function columns(body: SaveBankAccountRequest) {
  const iban = normalizeUaeIban(body.iban);
  if (!iban) throw fieldError('iban', 'invalid_iban');
  const swift = body.swift ? normalizeSwift(body.swift) : null;
  if (body.swift && !swift) throw fieldError('swift', 'invalid_swift');
  return {
    bank_name: body.bankName,
    account_name: body.accountName,
    iban,
    swift,
    ...(body.sortOrder !== undefined ? { sort_order: body.sortOrder } : {}),
  };
}

export async function listBankAccounts(db: Db, opts: { activeOnly?: boolean } = {}) {
  let q = db
    .selectFrom('sys.company_bank_accounts')
    .selectAll()
    .orderBy('is_active', 'desc')
    .orderBy('sort_order')
    .orderBy('id');
  if (opts.activeOnly) q = q.where('is_active', '=', true);
  return (await q.execute()).map((r): BankAccount => ({
    id: r.id.toString(),
    bankName: r.bank_name,
    accountName: r.account_name,
    iban: r.iban,
    swift: r.swift,
    sortOrder: r.sort_order,
    isActive: r.is_active,
    rowVersion: r.row_version,
  }));
}

async function one(db: Db, id: bigint): Promise<BankAccount> {
  const account = (await listBankAccounts(db)).find((a) => a.id === id.toString());
  if (!account) throw new AppError('NOT_FOUND', 'No such bank account');
  return account;
}

export async function createBankAccount(
  trx: Transaction<DB>,
  body: SaveBankAccountRequest,
): Promise<BankAccount> {
  const row = await trx
    .insertInto('sys.company_bank_accounts')
    .values(stamped('sys.company_bank_accounts', columns(body)))
    .returning('id')
    .executeTakeFirstOrThrow();
  return one(trx, row.id);
}

export async function updateBankAccount(
  trx: Transaction<DB>,
  id: bigint,
  body: SaveBankAccountRequest,
): Promise<BankAccount> {
  if (body.rowVersion === undefined) throw fieldError('rowVersion', 'required');
  const result = await trx
    .updateTable('sys.company_bank_accounts')
    .set(columns(body))
    .where('id', '=', id)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'sys.company_bank_accounts', id, result);
  return one(trx, id);
}

export async function setBankAccountActive(
  trx: Transaction<DB>,
  id: bigint,
  active: boolean,
  rowVersion: number,
): Promise<BankAccount> {
  const result = await trx
    .updateTable('sys.company_bank_accounts')
    .set({ is_active: active })
    .where('id', '=', id)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'sys.company_bank_accounts', id, result);
  return one(trx, id);
}
