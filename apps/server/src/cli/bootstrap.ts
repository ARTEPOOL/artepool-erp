/**
 * Server-console actions (decision 0025): the first owner, an enrollment code for the first PC,
 * and the emergency 2-step and password resets (decisions 0022, 0029). They run only where the database credentials
 * are, i.e. on the server PC. Each is audited as SYSTEM with a "server console" reason.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { recordEvent } from '../platform/audit/events';
import { checkPassword } from '../platform/auth/password-policy';
import { newTemporaryPassword } from '../platform/crypto/codes';
import type { SecretHasher } from '../platform/crypto/hashing';
import type { Db } from '../platform/db/pool';
import { stamped } from '../platform/db/stamped';
import { withBusinessTx } from '../platform/db/tx';
import type { SettingsCache } from '../platform/settings';
import { endSessions } from '../modules/auth/sessions';
import { createEnrollmentCode } from '../modules/devices/service';

export class ConsoleError extends Error {
  override readonly name = 'ConsoleError';
}

const consoleContext = (reason: string) => ({ userId: 1n, requestId: randomUUID(), reason });

async function activeOwner(db: Db) {
  return db
    .selectFrom('auth.users as u')
    .innerJoin('auth.user_roles as ur', 'ur.user_id', 'u.id')
    .innerJoin('auth.roles as r', 'r.id', 'ur.role_id')
    .select(['u.id', 'u.username'])
    .where('r.code', '=', 'owner')
    .where('u.is_active', '=', true)
    .executeTakeFirst();
}

export interface FirstOwnerInput {
  username: string;
  displayNameAr: string;
  displayNameEn: string;
  password: string;
}

/** Problems with the input, in plain English for the console (empty = fine). */
export async function checkFirstOwner(
  settings: SettingsCache,
  input: FirstOwnerInput,
): Promise<string[]> {
  const problems: string[] = [];
  if (!/^[a-z0-9._-]{3,32}$/.test(input.username)) {
    problems.push(
      'The username must be 3–32 lower-case letters, digits, dots, dashes or underscores.',
    );
  }
  if (!input.displayNameAr.trim() || !input.displayNameEn.trim()) {
    problems.push('Both names (Arabic and English) are required.');
  }
  const minLength = await settings.number('security.password_min_length');
  for (const problem of checkPassword(input.password, { minLength, username: input.username })) {
    problems.push(
      {
        too_short: `The password must have at least ${minLength} characters.`,
        too_long: 'The password is too long (128 characters at most).',
        common: 'This password is too common. Choose another one.',
        contains_username: 'The password must not contain the username.',
        one_character: 'The password must not be one repeated character.',
      }[problem],
    );
  }
  return problems;
}

/** `pnpm owner:create` — only while there is no active owner. */
export async function createFirstOwner(
  db: Db,
  hasher: SecretHasher,
  settings: SettingsCache,
  input: FirstOwnerInput,
): Promise<bigint> {
  const problems = await checkFirstOwner(settings, input);
  if (problems.length > 0) throw new ConsoleError(problems.join('\n'));
  if (await activeOwner(db)) {
    throw new ConsoleError(
      'An active owner already exists. This command only creates the first one.',
    );
  }
  const passwordHash = await hasher.hash(input.password);
  return withBusinessTx(db, consoleContext('server console: first owner'), async (trx) => {
    const user = await trx
      .insertInto('auth.users')
      .values(
        stamped('auth.users', {
          username: input.username,
          display_name_ar: input.displayNameAr.trim(),
          display_name_en: input.displayNameEn.trim(),
          sign_in_method: 'password_totp',
          password_hash: passwordHash,
          password_changed_at: sql<Date>`now()`,
          must_change_password: false,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`INSERT INTO auth.user_roles (user_id, role_id)
              SELECT ${user.id}, id FROM auth.roles WHERE code = 'owner'`.execute(trx);
    await recordEvent(trx, 'auth.owner_created', { entityType: 'auth.users', entityId: user.id });
    return user.id;
  });
}

/** `pnpm device:code` — a one-time enrollment code, same rules as Settings → Devices. */
export function createConsoleCode(
  db: Db,
  settings: SettingsCache,
): Promise<{ code: string; expiresAt: Date }> {
  return withBusinessTx(db, consoleContext('server console: enrollment code'), (trx) =>
    createEnrollmentCode(trx, { settings }, 'console'),
  );
}

/**
 * `pnpm owner:reset-2fa` — when the owner lost both the phone and the recovery codes. Clears the
 * 2-step setup, retires the recovery codes and ends the owner's sessions; the next sign-in asks
 * for a new setup. The written reason is kept in the audit log.
 */
export async function resetOwnerTwoStep(db: Db, reason: string): Promise<string> {
  if (reason.trim().length < 3)
    throw new ConsoleError('A reason of at least 3 characters is required.');
  const owner = await activeOwner(db);
  if (!owner) throw new ConsoleError('There is no active owner.');
  await withBusinessTx(
    db,
    consoleContext(`server console: 2-step reset — ${reason.trim()}`),
    async (trx) => {
      await trx
        .updateTable('auth.users')
        .set({ totp_enabled: false, totp_secret_enc: null, totp_last_step: null })
        .where('id', '=', owner.id)
        .execute();
      await trx
        .updateTable('auth.recovery_codes')
        .set({ revoked_at: sql`now()` })
        .where('user_id', '=', owner.id)
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .execute();
      await endSessions(trx, { userId: owner.id }, 'revoked');
      await recordEvent(trx, 'auth.owner_two_step_reset', {
        entityType: 'auth.users',
        entityId: owner.id,
        reason: reason.trim(),
      });
    },
  );
  return owner.username;
}

/**
 * `pnpm owner:reset-password` (decision 0029) — the last way back when the owner's password is
 * lost and "Forgot your password?" cannot be used (phone or recovery codes lost too). Sets a
 * temporary password, shown once, that must be changed at the next sign-in; unlocks; ends every
 * owner session (the database also ends every trusted PC). When the phone is lost too, clears
 * the 2-step setup as `owner:reset-2fa` does. The written reason is kept in the audit log.
 */
export async function resetOwnerPassword(
  db: Db,
  hasher: SecretHasher,
  input: { reason: string; phoneLost: boolean },
): Promise<{ username: string; temporaryPassword: string }> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new ConsoleError('A reason of at least 3 characters is required.');
  const owner = await activeOwner(db);
  if (!owner) throw new ConsoleError('There is no active owner.');
  const temporaryPassword = newTemporaryPassword();
  const hash = await hasher.hash(temporaryPassword);
  await withBusinessTx(
    db,
    consoleContext(`server console: password reset — ${reason}`),
    async (trx) => {
      await trx
        .updateTable('auth.users')
        .set({
          password_hash: hash,
          must_change_password: true,
          failed_login_count: 0,
          locked_until: null,
          ...(input.phoneLost
            ? { totp_enabled: false, totp_secret_enc: null, totp_last_step: null }
            : {}),
        })
        .where('id', '=', owner.id)
        .execute();
      if (input.phoneLost) {
        await trx
          .updateTable('auth.recovery_codes')
          .set({ revoked_at: sql`now()` })
          .where('user_id', '=', owner.id)
          .where('used_at', 'is', null)
          .where('revoked_at', 'is', null)
          .execute();
      }
      await endSessions(trx, { userId: owner.id }, 'revoked');
      await recordEvent(trx, 'auth.owner_password_reset', {
        entityType: 'auth.users',
        entityId: owner.id,
        reason,
        data: { twoStepCleared: input.phoneLost },
      });
    },
  );
  return { username: owner.username, temporaryPassword };
}
