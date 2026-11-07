/**
 * The actions behind "ARTÉPOOL – Emergency tool" (decision 0107): the same server code as the
 * console commands (decisions 0022, 0025, 0029), with JSON answers for the window instead of
 * prompts. Each change is written to the audit log with its reason, as from the console.
 *
 * `cashier-account` (M6.4) records what the window's "Set up / repair the cashier account" did:
 * the window ran `artepool-svc cashier-account setup`, moved the PC's enrollment and ran the
 * check; this writes the result to System health and one audit entry, with the Windows
 * administrator who ran it (read here, not sent by the window).
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { sql } from 'kysely';
import { z } from 'zod';
import { recordEvent } from '../platform/audit/events';
import { withBusinessTx } from '../platform/db/tx';
import type { SecretHasher } from '../platform/crypto/hashing';
import type { Db } from '../platform/db/pool';
import type { SettingsCache } from '../platform/settings';
import {
  activeOwner,
  createConsoleCode,
  resetOwnerPassword,
  resetOwnerTwoStep,
  windowsUser,
} from './bootstrap';
import { cashierCheckSchema } from './updater/cashier-account';

export const EMERGENCY_ACTIONS = [
  'status',
  'reset-password',
  'reset-2fa',
  'device-code',
  'cashier-account',
] as const;
export type EmergencyAction = (typeof EMERGENCY_ACTIONS)[number];

export type EmergencyFailure =
  | 'unknown_action'
  | 'bad_input'
  | 'reason_required'
  | 'no_owner'
  | 'database_unreachable'
  | 'failed';

export type EmergencyAnswer =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; reason: EmergencyFailure; detail?: string };

export interface EmergencyDeps {
  db: Db;
  hasher: SecretHasher;
  settings: SettingsCache;
}

const reasonOnly = z.object({ reason: z.string() });
const passwordReset = z.object({ reason: z.string(), phoneLost: z.boolean() });
const cashierAccount = z.object({
  /** The launcher's check after the set-up; null when it could not run. */
  check: cashierCheckSchema.nullable(),
  /** Why the set-up stopped, if it did (never a password: the launcher never prints one). */
  setupError: z.string().max(500).nullable(),
  /** The owner's enrollment was moved to the whole-PC file this time. */
  enrollmentMoved: z.boolean(),
});

/** The written reason, as the console asks for it: at least 3 characters. */
function reasonOf(reason: string): string | null {
  const trimmed = reason.trim();
  return trimmed.length >= 3 ? trimmed : null;
}

const fail = (reason: EmergencyFailure, detail?: string): EmergencyAnswer =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

async function databaseAnswers(db: Db): Promise<boolean> {
  try {
    await sql`SELECT 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}

export async function runEmergencyAction(
  deps: EmergencyDeps,
  action: string,
  input: unknown,
): Promise<EmergencyAnswer> {
  if (!(EMERGENCY_ACTIONS as readonly string[]).includes(action)) return fail('unknown_action');
  if (!(await databaseAnswers(deps.db))) return fail('database_unreachable');
  try {
    switch (action as EmergencyAction) {
      case 'status': {
        const state = await deps.db
          .selectFrom('sys.setup_state')
          .select('state')
          .where('id', '=', 1)
          .executeTakeFirst();
        const owner = await activeOwner(deps.db);
        const twoStep = owner
          ? await deps.db
              .selectFrom('auth.users')
              .select('totp_enabled')
              .where('id', '=', owner.id)
              .executeTakeFirstOrThrow()
          : null;
        return {
          ok: true,
          result: {
            setupComplete: state?.state === 'complete',
            owner: owner
              ? { username: owner.username, twoStep: twoStep?.totp_enabled ?? false }
              : null,
          },
        };
      }
      case 'reset-password': {
        const parsed = passwordReset.safeParse(input);
        if (!parsed.success) return fail('bad_input');
        const reason = reasonOf(parsed.data.reason);
        if (!reason) return fail('reason_required');
        if (!(await activeOwner(deps.db))) return fail('no_owner');
        const done = await resetOwnerPassword(deps.db, deps.hasher, {
          reason: `emergency tool — ${reason}`,
          phoneLost: parsed.data.phoneLost,
        });
        return {
          ok: true,
          result: {
            username: done.username,
            temporaryPassword: done.temporaryPassword,
            twoStepCleared: parsed.data.phoneLost,
          },
        };
      }
      case 'reset-2fa': {
        const parsed = reasonOnly.safeParse(input);
        if (!parsed.success) return fail('bad_input');
        const reason = reasonOf(parsed.data.reason);
        if (!reason) return fail('reason_required');
        if (!(await activeOwner(deps.db))) return fail('no_owner');
        const username = await resetOwnerTwoStep(deps.db, `emergency tool — ${reason}`);
        return { ok: true, result: { username } };
      }
      case 'cashier-account': {
        const parsed = cashierAccount.safeParse(input);
        if (!parsed.success) return fail('bad_input');
        const { check, setupError, enrollmentMoved } = parsed.data;
        const who = windowsUser();
        const outcome = setupError ? 'failed' : (check?.state ?? 'not checked');
        const reason = `emergency tool — cashier account set up / repaired by ${who}: ${outcome}`;
        await withBusinessTx(
          deps.db,
          { userId: 1n, requestId: randomUUID(), reason },
          async (trx) => {
            await trx
              .updateTable('ops.server_health')
              .set({
                cashier_account_setup_at: sql<Date>`now()`,
                ...(check
                  ? {
                      cashier_account_state: check.state,
                      cashier_account_missing: check.missing,
                      cashier_account_checked_at: sql<Date>`now()`,
                    }
                  : {}),
              })
              .where('id', '=', 1)
              .execute();
            await recordEvent(trx, 'system.cashier_account_setup', {
              entityType: 'ops.server_health',
              entityId: 1n,
              reason,
              data: {
                state: check?.state ?? null,
                missing: check?.missing ?? [],
                setupError,
                enrollmentMoved,
                windowsUser: who,
                pc: hostname(),
              },
            });
          },
        );
        return {
          ok: true,
          result: {
            state: check?.state ?? null,
            missing: check?.missing ?? [],
            setupError,
            enrollmentMoved,
          },
        };
      }
      case 'device-code': {
        const { code, expiresAt } = await createConsoleCode(
          deps.db,
          deps.settings,
          'emergency tool: enrollment code',
        );
        return { ok: true, result: { code, expiresAt: expiresAt.toISOString() } };
      }
    }
  } catch (error) {
    return fail('failed', error instanceof Error ? error.message : String(error));
  }
}
