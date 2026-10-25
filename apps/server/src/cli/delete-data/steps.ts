/**
 * Deleting the server PC's data (decision 0103, M6.2 part G4): a separate, unticked choice of the
 * uninstaller, never a default. It needs, in this order:
 *
 *   1. the word DELETE typed exactly;
 *   2. the owner's password, checked against the database (both a refusal and a confirmation are
 *      written to the audit log while it still exists, and to the install log, which stays);
 *   3. then the services stop and the database, its write-ahead log, the secrets, the settings,
 *      the first-run setup files and the update files are removed.
 *
 * The backups folder and the logs always stay.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recordEvent } from '../../platform/audit/events';
import type { SecretHasher } from '../../platform/crypto/hashing';
import type { Db } from '../../platform/db/pool';
import { withBusinessTx } from '../../platform/db/tx';
import type { InstallLog } from '../install/log';
import type { ServiceKey } from '../install/windows';

/** What is removed, in ProgramData\ARTEPOOL; `backups` and `logs` are never in this list. */
export const DELETED_FOLDERS = ['pgdata', 'wal', 'secrets', 'config', 'setup', 'updates'] as const;

export const CONFIRMATION_WORD = 'DELETE';

export type DeleteDataResult =
  | { ok: true; removed: string[] }
  | { ok: false; reason: 'not_confirmed' | 'no_owner' | 'wrong_password' };

export interface DeleteDataInput {
  db: Db;
  hasher: SecretHasher;
  password: string;
  confirmation: string;
  dataDir: string;
  /** Closes the database connections before the database service stops. */
  closeDb: () => Promise<void>;
  stopService: (service: ServiceKey) => Promise<void>;
  log: InstallLog;
}

async function audit(db: Db, event: string, reason: string): Promise<void> {
  await withBusinessTx(db, { userId: 1n, requestId: randomUUID(), reason }, (trx) =>
    recordEvent(trx, event, { entityType: 'sys.setup_state', entityId: 1n, reason }),
  );
}

export async function deleteData(input: DeleteDataInput): Promise<DeleteDataResult> {
  const { db, log } = input;
  if (input.confirmation.trim() !== CONFIRMATION_WORD) {
    log.line(`Delete data: refused (${CONFIRMATION_WORD} was not typed). Nothing was deleted.`);
    return { ok: false, reason: 'not_confirmed' };
  }
  const owner = await db
    .selectFrom('auth.users as u')
    .innerJoin('auth.user_roles as ur', 'ur.user_id', 'u.id')
    .innerJoin('auth.roles as r', 'r.id', 'ur.role_id')
    .select(['u.id', 'u.username', 'u.password_hash'])
    .where('r.code', '=', 'owner')
    .where('u.is_active', '=', true)
    .executeTakeFirst();
  if (!owner) {
    log.line('Delete data: refused (there is no active owner). Nothing was deleted.');
    return { ok: false, reason: 'no_owner' };
  }
  if (!(await input.hasher.verifyOrDummy(owner.password_hash, input.password))) {
    await audit(db, 'system.data_delete_refused', 'uninstall: wrong owner password');
    log.line("Delete data: refused (the owner's password is wrong). Nothing was deleted.");
    return { ok: false, reason: 'wrong_password' };
  }
  await audit(db, 'system.data_delete_confirmed', 'uninstall: the owner chose to delete the data');
  log.line(`Delete data: confirmed by the owner (${owner.username}).`);
  await input.closeDb();

  for (const service of ['backup', 'server', 'database'] as const) {
    await input.stopService(service);
  }
  const removed: string[] = [];
  for (const folder of DELETED_FOLDERS) {
    await rm(join(input.dataDir, folder), { recursive: true, force: true });
    removed.push(folder);
    log.line(`Delete data: ${folder} removed.`);
  }
  log.line('Delete data: done. The backups folder and the logs are kept.');
  return { ok: true, removed };
}
