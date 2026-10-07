/**
 * T6: supervisor approvals (architecture §5.5) — a single-use loan of a permission, for five
 * minutes, from someone else who holds it, with their PIN and a reason.
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

let server: TestServer;
let pos: TestDevice;
let cashier: bigint;
let cashierToken: string;
let supervisor: bigint;
let supervisorToken: string;

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
  supervisor = await addUser(server, {
    username: 'khaled.acc',
    roles: ['accountant'],
    pin: '5291',
  });
  await addUser(server, { username: 'no.pin', roles: ['accountant'] });
  cashierToken = (await openSession(server, { userId: cashier, deviceId: pos.id, method: 'pin' }))
    .token;
  supervisorToken = (await openSession(server, { userId: supervisor, deviceId: pos.id })).token;
});
afterAll(() => server.close());

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
  it('lists who can approve: holds the permission, has a PIN, is someone else', async () => {
    const response = await call(
      server,
      'GET',
      '/api/v1/approvals/approvers?permission=sales.discount_over_limit',
      {
        device: pos,
        token: cashierToken,
      },
    );
    const { approvers } = response.json<{ approvers: Approver[] }>();
    expect(approvers.map((a) => a.id)).toEqual([supervisor.toString()]);
  });

  it('is given with the supervisor PIN and a reason, for five minutes, and used once', async () => {
    const given = await ask(cashierToken, { approverId: supervisor.toString(), pin: '5291' });
    expect(given.statusCode).toBe(201);
    const approval = given.json<ApprovalResponse>();
    const minutes = (Date.parse(approval.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(4.5);
    expect(minutes).toBeLessThanOrEqual(5);
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
      await ask(cashierToken, { approverId: supervisor.toString(), pin: '5291' })
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

  it('refuses self-approval, approvers without the permission, and actions that cannot be approved', async () => {
    expect(
      errorCode(await ask(supervisorToken, { approverId: supervisor.toString(), pin: '5291' })),
    ).toBe('APPROVAL_INVALID');
    const tech = await addUser(server, {
      username: 'tech.one',
      roles: ['technician'],
      pin: '6183',
    });
    expect(errorCode(await ask(cashierToken, { approverId: tech.toString(), pin: '6183' }))).toBe(
      'APPROVAL_INVALID',
    );
    expect(
      errorCode(
        await ask(cashierToken, {
          approverId: supervisor.toString(),
          pin: '5291',
          permission: 'users.manage',
        }),
      ),
    ).toBe('APPROVAL_INVALID');
    expect(
      errorCode(
        await ask(cashierToken, { approverId: supervisor.toString(), pin: '5291', reason: 'x' }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('blocks the approver PIN after 5 wrong tries', async () => {
    const answers: string[] = [];
    for (let i = 0; i < 5; i++) {
      answers.push(
        errorCode(await ask(cashierToken, { approverId: supervisor.toString(), pin: `30${i}7` })) ??
          '',
      );
    }
    expect(answers).toEqual([
      'INVALID_PIN',
      'INVALID_PIN',
      'INVALID_PIN',
      'INVALID_PIN',
      'PIN_BLOCKED',
    ]);
    // Even the right PIN is refused until the owner unblocks it.
    expect(
      errorCode(await ask(cashierToken, { approverId: supervisor.toString(), pin: '5291' })),
    ).toBe('PIN_BLOCKED');
  });
});
