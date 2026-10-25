/**
 * Supervisor approvals (architecture §5.5): a single-use loan of a permission, for 5 minutes,
 * given by someone else who holds it, with the one-time code from their phone's 2-step app and a
 * reason (decision 0074). The database enforces the
 * rules again (approver ≠ requester, approver holds the permission, expiry, single use).
 */
import type { FastifyRequest } from 'fastify';
import { sql, type Transaction } from 'kysely';
import type { ApprovalRequest, ApprovalResponse, Approver } from '@artepool/shared/contracts';
import { verifyTotp } from '../../platform/auth/totp';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { withBusinessTx } from '../../platform/db/tx';
import { AppError } from '../../platform/errors/app-error';
import { contextOf } from '../../platform/http/context';
import type { AppDeps } from '../../platform/http/deps';
import { recordEvent } from '../../platform/audit/events';
import { rateCheck, totpAad } from '../auth/service';

/**
 * People who can approve this action now: active, hold the permission, have 2-step turned on, and
 * are not blocked for wrong approval codes.
 */
export async function approvers(
  deps: AppDeps,
  request: FastifyRequest,
  permission: string,
): Promise<Approver[]> {
  const rows = await deps.db
    .selectFrom('auth.users')
    .select(['id', 'display_name_ar', 'display_name_en'])
    .where('is_active', '=', true)
    .where('totp_enabled', '=', true)
    .where('totp_secret_enc', 'is not', null)
    .where('approval_blocked_at', 'is', null)
    .where('id', '<>', request.auth!.userId)
    .where(sql<boolean>`auth.user_has_permission(id, ${permission})`)
    .orderBy('display_name_en')
    .execute();
  return rows.map((r) => ({
    id: r.id.toString(),
    displayNameAr: r.display_name_ar,
    displayNameEn: r.display_name_en,
  }));
}

/** One more wrong approval code; true when the person's approvals are now blocked. */
async function approvalFailed(trx: Transaction<DB>, deps: AppDeps, userId: bigint) {
  const { approval_failed_count: attempts } = await trx
    .updateTable('auth.users')
    .set({ approval_failed_count: sql`approval_failed_count + 1` })
    .where('id', '=', userId)
    .returning('approval_failed_count')
    .executeTakeFirstOrThrow();
  await recordEvent(trx, 'auth.approval_code_failed', {
    entityType: 'auth.users',
    entityId: userId.toString(),
    data: { attempts },
  });
  if (attempts < (await deps.settings.number('security.max_failed_pins'))) return false;
  await trx
    .updateTable('auth.users')
    .set({ approval_blocked_at: sql`now()` })
    .where('id', '=', userId)
    .execute();
  return true;
}

/**
 * The approver types the current code from their phone on the requester's PC (decision 0074). It
 * changes every 30 seconds and is accepted once: a code seen over a shoulder is useless. Wrong
 * codes count towards blocking that person's approvals (never their sign-in).
 */
export async function createApproval(
  deps: AppDeps,
  request: FastifyRequest,
  body: ApprovalRequest,
): Promise<ApprovalResponse> {
  rateCheck(deps, request);
  const approver = await deps.db
    .selectFrom('auth.users')
    .select([
      'id',
      'totp_enabled',
      'totp_secret_enc',
      'totp_last_step',
      'approval_blocked_at',
      'is_active',
    ])
    .where('id', '=', BigInt(body.approverId))
    .executeTakeFirst();
  const usable =
    approver?.is_active === true &&
    approver.approval_blocked_at === null &&
    approver.totp_enabled &&
    approver.totp_secret_enc !== null;
  const step = usable
    ? verifyTotp(
        deps.secretBox.open(approver.totp_secret_enc!, totpAad(approver.id)).toString('utf8'),
        body.code,
        approver.totp_last_step,
      )
    : null;
  if (step === null) {
    const blocked =
      approver && approver.totp_enabled
        ? await withBusinessTx(deps.db, contextOf(request), (trx) =>
            approver.approval_blocked_at !== null
              ? Promise.resolve(true)
              : approvalFailed(trx, deps, approver.id),
          )
        : false;
    if (blocked) throw new AppError('APPROVAL_BLOCKED', 'Approver blocked for approvals');
    throw new AppError('INVALID_TWO_STEP_CODE', 'Wrong approval code');
  }
  return withBusinessTx(deps.db, contextOf(request, { reason: body.reason }), async (trx) => {
    // Claim the code: the same code never approves (or signs in) twice.
    const claimed = await trx
      .updateTable('auth.users')
      .set({ approval_failed_count: 0, totp_last_step: step })
      .where('id', '=', approver!.id)
      .where((eb) => eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', step)]))
      .executeTakeFirst();
    if (claimed.numUpdatedRows === 0n) {
      throw new AppError('INVALID_TWO_STEP_CODE', 'Code already used');
    }
    const row = await trx
      .insertInto('auth.approvals')
      .values(
        stamped('auth.approvals', {
          permission_code: body.permission,
          approved_by: approver!.id,
          reason_text: body.reason,
          context: JSON.stringify(body.context),
        } as never),
      )
      .returning(['id', 'expires_at'])
      .executeTakeFirstOrThrow();
    return { approvalId: row.id.toString(), expiresAt: row.expires_at.toISOString() };
  });
}

/**
 * Uses an approval inside the business transaction it allows (M4/M5 call this): only for the
 * approved action, once, before it expires, by the person who asked. Returns its context so
 * the caller can check it matches (amounts, item, …).
 */
export async function consumeApproval(
  trx: Transaction<DB>,
  approvalId: bigint,
  permission: string,
  entity: string,
): Promise<Record<string, unknown>> {
  const used = await trx
    .updateTable('auth.approvals')
    .set({ consumed_at: sql`now()`, consumed_entity: entity })
    .where('id', '=', approvalId)
    .where('permission_code', '=', permission)
    .returning('context')
    .executeTakeFirst();
  if (!used) throw new AppError('APPROVAL_INVALID', 'No such approval for this action');
  return used.context as Record<string, unknown>;
}
