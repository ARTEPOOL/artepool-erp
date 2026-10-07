/**
 * Supervisor approvals (architecture §5.5): a single-use loan of a permission, for 5 minutes,
 * given by someone else who holds it, with their PIN and a reason. The database enforces the
 * rules again (approver ≠ requester, approver holds the permission, expiry, single use).
 */
import type { FastifyRequest } from 'fastify';
import { sql, type Transaction } from 'kysely';
import type { ApprovalRequest, ApprovalResponse, Approver } from '@artepool/shared/contracts';
import { normalizePin } from '../../platform/auth/pin-policy';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { withBusinessTx } from '../../platform/db/tx';
import { AppError } from '../../platform/errors/app-error';
import { contextOf } from '../../platform/http/context';
import type { AppDeps } from '../../platform/http/deps';
import { pinFailed, rateCheck } from '../auth/service';

/** People who can approve this action now: active, hold the permission, have a working PIN. */
export async function approvers(
  deps: AppDeps,
  request: FastifyRequest,
  permission: string,
): Promise<Approver[]> {
  const rows = await deps.db
    .selectFrom('auth.users')
    .select(['id', 'display_name_ar', 'display_name_en'])
    .where('is_active', '=', true)
    .where('pin_hash', 'is not', null)
    .where('pin_blocked_at', 'is', null)
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

/** The approver types their PIN on the requester's PC; a wrong PIN counts towards their block. */
export async function createApproval(
  deps: AppDeps,
  request: FastifyRequest,
  body: ApprovalRequest,
): Promise<ApprovalResponse> {
  rateCheck(deps, request);
  const approver = await deps.db
    .selectFrom('auth.users')
    .select(['id', 'pin_hash', 'pin_blocked_at', 'is_active'])
    .where('id', '=', BigInt(body.approverId))
    .executeTakeFirst();
  const usable = approver?.is_active === true && approver.pin_blocked_at === null;
  const ok = await deps.hasher.verifyOrDummy(
    usable ? approver.pin_hash : null,
    normalizePin(body.pin),
  );
  if (!ok) {
    const blocked =
      approver && approver.pin_hash
        ? await withBusinessTx(deps.db, contextOf(request), (trx) =>
            approver.pin_blocked_at !== null
              ? Promise.resolve(true)
              : pinFailed(trx, deps, approver.id, 'approval'),
          )
        : false;
    if (blocked) throw new AppError('PIN_BLOCKED', 'Approver PIN blocked');
    throw new AppError('INVALID_PIN', 'Wrong approver PIN');
  }
  return withBusinessTx(deps.db, contextOf(request, { reason: body.reason }), async (trx) => {
    await trx
      .updateTable('auth.users')
      .set({ pin_failed_count: 0 })
      .where('id', '=', approver!.id)
      .execute();
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
