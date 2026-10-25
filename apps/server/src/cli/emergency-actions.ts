/**
 * The actions behind "ARTÉPOOL – Emergency tool" (decision 0107): the same server code as the
 * console commands (decisions 0022, 0025, 0029), with JSON answers for the window instead of
 * prompts. Each change is written to the audit log with its reason, as from the console.
 */
import { sql } from 'kysely';
import { z } from 'zod';
import type { SecretHasher } from '../platform/crypto/hashing';
import type { Db } from '../platform/db/pool';
import type { SettingsCache } from '../platform/settings';
import { activeOwner, createConsoleCode, resetOwnerPassword, resetOwnerTwoStep } from './bootstrap';

export const EMERGENCY_ACTIONS = ['status', 'reset-password', 'reset-2fa', 'device-code'] as const;
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
