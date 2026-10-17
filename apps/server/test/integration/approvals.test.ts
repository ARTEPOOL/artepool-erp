/**
 * T6: supervisor approvals (architecture §5.5) — a single-use loan of a permission, for five
 * minutes, from someone else who holds it, with the one-time code from their phone's 2-step app
 * and a reason (decision 0074).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalResponse, Approver } from '@artepool/shared/contracts';
import { defineWrite } from '../../src/platform/http/route';
import { consumeApproval } from '../../src/modules/approvals/service';
import {
  addDevice,
  addUser,
  ageRow,
  call,
  errorCode,
  openSession,
  startTestServer,
  type TestDevice,
  type TestServer,
} from '../support/server';
import { addOwnerWithTwoStep } from '../support/https';
import { totpCode } from '../../src/platform/auth/totp';

let server: TestServer;
let pos: TestDevice;
let cashier: bigint;
let cashierToken: string;
let supervisor: bigint;
let supervisorToken: string;
let supervisorSecret: string;
let noTwoStep: bigint;

beforeAll(async () => {
  server = await startTestServer((app) => {
    // Stands in for a POS sale that needs an approved discount (M5).
    defineWrite(app, {
      method: 'POST',
      url: '/t/discounted-sale',
      access: { kind: 'session' },
      body: z.object({
        approvalId: z.string(),
        permission: z.string().default('sales.discount_over_limit'),
      }),
      handler: async ({ trx, body }) => ({
        body: await consumeApproval(
          trx,
          BigInt(body.approvalId),
          body.permission,
          'sales.documents:1',
        ),
      }),
    });
  });
  pos = await addDevice(server, { code: 'COUNTER-01', kind: 'pos' });
  cashier = await addUser(server, { username: 'ahmed.cashier', method: 'pin', roles: ['cashier'] });
  const sup = await addOwnerWithTwoStep(server, { username: 'khaled.acc', roles: ['accountant'] });
  supervisor = sup.id;
  supervisorSecret = sup.secret;
  // An accountant with a PIN but no 2-step: never an approver.
  noTwoStep = await addUser(server, { username: 'no.twostep', roles: ['accountant'], pin: '5291' });
  cashierToken = (await openSession(server, { userId: cashier, deviceId: pos.id, method: 'pin' }))
    .token;
  supervisorToken = (
    await openSession(server, { userId: supervisor, deviceId: pos.id, method: 'password_totp' })
  ).token;
});
afterAll(() => server.close());

/** The supervisor's current code, as their phone shows it; each code works once. */
async function code(): Promise<string> {
  await ageRow(server, `UPDATE auth.users SET totp_last_step = NULL WHERE id = $1`, [supervisor]);
  return totpCode(supervisorSecret, Date.now());
}

const ask = (token: string, body: Record<string, unknown>) =>
  call(server, 'POST', '/api/v1/approvals', {
    device: pos,
    token,
    body: {
      permission: 'sales.discount_over_limit',
      reason: 'Regular customer',
      context: { discountBp: 800 },
      ...body,
    },
  });

const use = (token: string, approvalId: string, permission?: string) =>
  call(server, 'POST', '/t/discounted-sale', {
    device: pos,
    token,
    idempotencyKey: randomUUID(),
    body: { approvalId, ...(permission ? { permission } : {}) },
  });

describe('approvals', () => {
  it('lists who can approve: holds the permission, has 2-step on, is someone else', async () => {
    const response = await call(
      server,
      'GET',
      '/api/v1/approvals/approvers?permission=sales.discount_over_limit',
      { device: pos, token: cashierToken },
    );
    const { approvers } = response.json<{ approvers: Approver[] }>();
    expect(approvers.map((a) => a.id)).toEqual([supervisor.toString()]);
    expect(approvers.map((a) => a.id)).not.toContain(noTwoStep.toString());
  });

  it('is given with the code from the phone and a reason, for five minutes, and used once', async () => {
    const now = await code();
    const given = await ask(cashierToken, { approverId: supervisor.toString(), code: now });
    expect(given.statusCode).toBe(201);
    const approval = given.json<ApprovalResponse>();
    const minutes = (Date.parse(approval.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(4.5);
    expect(minutes).toBeLessThanOrEqual(5);
    // The same code never works twice, even seen over a shoulder.
    expect(
      errorCode(await ask(cashierToken, { approverId: supervisor.toString(), code: now })),
    ).toBe('INVALID_TWO_STEP_CODE');
    expect((await use(cashierToken, approval.approvalId)).json()).toEqual({ discountBp: 800 });
    expect(errorCode(await use(cashierToken, approval.approvalId))).toBe('APPROVAL_INVALID');
    const row = await server.db
      .selectFrom('auth.approvals')
      .select(['requested_by', 'approved_by', 'device_id', 'reason_text', 'consumed_entity'])
      .where('id', '=', BigInt(approval.approvalId))
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      requested_by: cashier,
      approved_by: supervisor,
      device_id: pos.id,
      reason_text: 'Regular customer',
      consumed_entity: 'sales.documents:1',
    });
  });

  it('is refused for the wrong action, by someone else, or after it expires', async () => {
    const approvalId = (
      await ask(cashierToken, { approverId: supervisor.toString(), code: await code() })
    ).json<ApprovalResponse>().approvalId;
    expect(errorCode(await use(cashierToken, approvalId, 'pos.oversell'))).toBe('APPROVAL_INVALID');
    expect(errorCode(await use(supervisorToken, approvalId))).toBe('APPROVAL_INVALID');
    await ageRow(
      server,
      `UPDATE auth.approvals SET approved_at = now() - interval '10 minutes',
              expires_at = now() - interval '5 minutes' WHERE id = $1`,
      [approvalId],
    );
    expect(errorCode(await use(cashierToken, approvalId))).toBe('APPROVAL_INVALID');
  });

  it('refuses self-approval, approvers without 2-step or the permission, and unapprovable actions', async () => {
    expect(
      errorCode(
        await ask(supervisorToken, { approverId: supervisor.toString(), code: await code() }),
      ),
    ).toBe('APPROVAL_INVALID');
    // A PIN is no longer an approval code.
    expect(
      errorCode(await ask(cashierToken, { approverId: noTwoStep.toString(), code: '529100' })),
    ).toBe('INVALID_TWO_STEP_CODE');
    const tech = await addOwnerWithTwoStep(server, { username: 'tech.one', roles: ['technician'] });
    expect(
      errorCode(
        await ask(cashierToken, {
          approverId: tech.id.toString(),
          code: totpCode(tech.secret, Date.now()),
        }),
      ),
    ).toBe('APPROVAL_INVALID');
    expect(
      errorCode(
        await ask(cashierToken, {
          approverId: supervisor.toString(),
          code: await code(),
          permission: 'users.manage',
        }),
      ),
    ).toBe('APPROVAL_INVALID');
    expect(
      errorCode(
        await ask(cashierToken, { approverId: supervisor.toString(), code: '1234', reason: 'x' }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('blocks the approver’s approvals (never their sign-in) after 5 wrong codes', async () => {
    const answers: string[] = [];
    for (let i = 0; i < 5; i++) {
      answers.push(
        errorCode(
          await ask(cashierToken, { approverId: supervisor.toString(), code: `00000${i}` }),
        ) ?? '',
      );
    }
    expect(answers).toEqual([
      'INVALID_TWO_STEP_CODE',
      'INVALID_TWO_STEP_CODE',
      'INVALID_TWO_STEP_CODE',
      'INVALID_TWO_STEP_CODE',
      'APPROVAL_BLOCKED',
    ]);
    // Even the right code is refused until the owner unblocks it.
    expect(
      errorCode(await ask(cashierToken, { approverId: supervisor.toString(), code: await code() })),
    ).toBe('APPROVAL_BLOCKED');
    const user = await server.db
      .selectFrom('auth.users')
      .select(['locked_until'])
      .where('id', '=', supervisor)
      .executeTakeFirstOrThrow();
    expect(user.locked_until).toBeNull(); // their sign-in is not affected
  });
});
