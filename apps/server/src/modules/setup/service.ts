/**
 * The first-run wizard on the server PC, path "New setup" (decisions 0092, 0102; M6.2 part D):
 * company details → the owner → phone 2-step and recovery codes → this PC enrolled as the POS →
 * complete. Nobody is signed in yet, so every request must:
 *
 * - come from the server PC itself (the connection's own address is 127.0.0.1 or ::1),
 * - carry the installer's one-time token (a file only Windows administrators can read), and
 * - arrive before setup is complete (the database never lets the state go back).
 *
 * Each step is one transaction audited as SYSTEM with the reason "setup wizard", and may be
 * repeated until complete. At the end the token file is deleted.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import type { FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import {
  SETUP_TOKEN_HEADER,
  SetupToken,
  type SaveCompanyRequest,
  type SetupDeviceCodeResponse,
  type SetupOwnerRequest,
  type SetupStatusResponse,
  type SetupTwoStepConfirmResponse,
  type TwoStepStartResponse,
} from '@artepool/shared/contracts';
import { activeOwner, createFirstOwner, firstOwnerProblems } from '../../cli/bootstrap';
import { newTotpSecret, totpUri, verifyTotp } from '../../platform/auth/totp';
import type { DB } from '../../platform/db/schema.generated';
import { withBusinessTx, type RequestContext } from '../../platform/db/tx';
import { AppError, ruleError } from '../../platform/errors/app-error';
import { header } from '../../platform/http/context';
import type { AppDeps } from '../../platform/http/deps';
import { newRecoveryCodes, storeTwoStep } from '../auth/service';
import * as company from '../company/service';
import { createEnrollmentCode } from '../devices/service';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const TWO_STEP_SETUP_MS = 10 * 60_000;

const unavailable = () =>
  new AppError('SETUP_UNAVAILABLE', 'Setup answers only on the server PC with the setup token');

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();

/** From the server PC itself, with the installer's token: otherwise refused, saying nothing more. */
export async function assertSetupAccess(
  deps: Pick<AppDeps, 'setupTokenFile'>,
  request: FastifyRequest,
): Promise<void> {
  // The connection's own address, never a forwarded header.
  if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) throw unavailable();
  const given = header(request, SETUP_TOKEN_HEADER);
  let expected: string;
  try {
    expected = (await readFile(deps.setupTokenFile, 'utf8')).trim();
  } catch {
    throw unavailable();
  }
  if (!given || !SetupToken.safeParse(expected).success) throw unavailable();
  if (!timingSafeEqual(sha256(given), sha256(expected))) throw unavailable();
}

export const setupContext = (request: FastifyRequest): RequestContext => ({
  userId: 1n,
  requestId: request.id ?? randomUUID(),
  clientIp: request.ip,
  reason: 'setup wizard',
});

async function stateOf(db: AppDeps['db']) {
  return db
    .selectFrom('sys.setup_state')
    .select(['state', 'path', 'started_at'])
    .executeTakeFirstOrThrow();
}

/** Every step but "start" needs setup in progress; nothing is done once complete. */
async function assertInProgress(db: AppDeps['db']): Promise<{ started_at: Date | null }> {
  const state = await stateOf(db);
  if (state.state === 'complete') throw ruleError('SETUP_ALREADY_DONE', 'Setup is complete');
  if (state.state !== 'in_progress') {
    throw new AppError('PERMISSION_DENIED', 'Start the setup first');
  }
  return state;
}

async function ownerRow(db: AppDeps['db']) {
  const owner = await activeOwner(db);
  if (!owner) return null;
  return db
    .selectFrom('auth.users')
    .select(['id', 'username', 'display_name_ar', 'display_name_en', 'totp_enabled'])
    .where('id', '=', owner.id)
    .executeTakeFirstOrThrow();
}

/** The POS PC enrolled since setup started (this PC). */
async function setupPosDevice(db: AppDeps['db'], startedAt: Date | null) {
  if (!startedAt) return null;
  return (
    (await db
      .selectFrom('auth.devices')
      .select(['code', 'name'])
      .where('device_kind', '=', 'pos')
      .where('status', '=', 'active')
      .where('enrolled_at', '>=', startedAt)
      .orderBy('id', 'desc')
      .executeTakeFirst()) ?? null
  );
}

export async function setupStatus(deps: AppDeps): Promise<SetupStatusResponse> {
  const state = await stateOf(deps.db);
  const owner = await ownerRow(deps.db);
  return {
    state: state.state as SetupStatusResponse['state'],
    path: state.path as SetupStatusResponse['path'],
    company: await company.getCompany(deps.db),
    owner: owner && {
      username: owner.username,
      displayNameAr: owner.display_name_ar,
      displayNameEn: owner.display_name_en,
      twoStepEnabled: owner.totp_enabled,
    },
    posDevice: await setupPosDevice(deps.db, state.started_at),
  };
}

export async function startSetup(deps: AppDeps, request: FastifyRequest): Promise<void> {
  const state = await stateOf(deps.db);
  if (state.state === 'complete') throw ruleError('SETUP_ALREADY_DONE', 'Setup is complete');
  if (state.state === 'in_progress') {
    if (state.path !== 'new') throw new AppError('PERMISSION_DENIED', 'Another path was chosen');
    return;
  }
  await withBusinessTx(deps.db, setupContext(request), (trx) =>
    trx
      .updateTable('sys.setup_state')
      .set({ state: 'in_progress', path: 'new' })
      .where('id', '=', 1)
      .execute(),
  );
}

async function currentRowVersion(trx: Transaction<DB>): Promise<number | undefined> {
  const row = await trx
    .selectFrom('sys.company_profile')
    .select('row_version')
    .where('id', '=', 1)
    .executeTakeFirst();
  return row?.row_version;
}

/** Step 1: the company details (the same rules as Settings → Company). Saving again replaces them. */
export async function saveSetupCompany(
  deps: AppDeps,
  request: FastifyRequest,
  body: SaveCompanyRequest,
) {
  await assertInProgress(deps.db);
  return withBusinessTx(deps.db, setupContext(request), async (trx) => {
    const rowVersion = await currentRowVersion(trx);
    return company.saveCompany(trx, { ...body, rowVersion });
  });
}

export async function saveSetupLogo(
  deps: AppDeps,
  request: FastifyRequest,
  logo: { type: 'image/png' | 'image/jpeg'; dataBase64: string } | null,
) {
  await assertInProgress(deps.db);
  return withBusinessTx(deps.db, setupContext(request), async (trx) => {
    const rowVersion = await currentRowVersion(trx);
    if (rowVersion === undefined) {
      throw new AppError('PERMISSION_DENIED', 'Save the company details first');
    }
    return company.saveLogo(trx, { logo, rowVersion });
  });
}

/** Step 2: the owner (the only account made here). Repeating it with the same username is fine. */
export async function createSetupOwner(
  deps: AppDeps,
  request: FastifyRequest,
  body: SetupOwnerRequest,
): Promise<void> {
  await assertInProgress(deps.db);
  const existing = await ownerRow(deps.db);
  if (existing) {
    if (existing.username === body.username) return;
    throw new AppError('OWNER_PROTECTED', 'The owner was already created');
  }
  const problems = await firstOwnerProblems(deps.settings, body);
  const issues = [
    ...(problems.username ? [{ path: ['username'], code: 'invalid_format' }] : []),
    ...(problems.names
      ? [
          ...(body.displayNameAr ? [] : [{ path: ['displayNameAr'], code: 'too_small' }]),
          ...(body.displayNameEn ? [] : [{ path: ['displayNameEn'], code: 'too_small' }]),
        ]
      : []),
  ];
  if (issues.length > 0) {
    throw new AppError('VALIDATION_FAILED', 'Invalid owner details', { part: 'body', issues });
  }
  if (problems.password.length > 0) {
    throw new AppError('PASSWORD_REJECTED', 'Password refused', {
      problems: problems.password,
      minLength: problems.minLength,
    });
  }
  await createFirstOwner(deps.db, deps.hasher, deps.settings, body, 'setup wizard');
}

/** The secret being set up, kept in memory only until the phone's first code matches. */
let pendingTwoStep: { ownerId: bigint; secret: string; expires: number } | null = null;

async function ownerForTwoStep(deps: AppDeps) {
  const owner = await ownerRow(deps.db);
  if (!owner) throw new AppError('PERMISSION_DENIED', 'Create the owner first');
  if (owner.totp_enabled) throw new AppError('PERMISSION_DENIED', '2-step is already set up');
  return owner;
}

/** Step 3a: a new 2-step secret, as a QR code for the owner's phone. */
export async function startSetupTwoStep(deps: AppDeps): Promise<TwoStepStartResponse> {
  await assertInProgress(deps.db);
  const owner = await ownerForTwoStep(deps);
  const secret = newTotpSecret();
  pendingTwoStep = { ownerId: owner.id, secret, expires: Date.now() + TWO_STEP_SETUP_MS };
  return { secret, uri: totpUri(secret, owner.username) };
}

/** Step 3b: the phone's code matches → 2-step on, and the 10 recovery codes (shown once). */
export async function confirmSetupTwoStep(
  deps: AppDeps,
  request: FastifyRequest,
  code: string,
): Promise<SetupTwoStepConfirmResponse> {
  await assertInProgress(deps.db);
  const owner = await ownerForTwoStep(deps);
  const pending = pendingTwoStep;
  if (!pending || pending.ownerId !== owner.id || pending.expires < Date.now()) {
    pendingTwoStep = null;
    throw new AppError('INVALID_TWO_STEP_CODE', 'No 2-step setup in progress');
  }
  const step = verifyTotp(pending.secret, code, null);
  if (step === null) throw new AppError('INVALID_TWO_STEP_CODE', 'Setup code does not match');
  const recovery = await newRecoveryCodes(deps);
  await withBusinessTx(deps.db, setupContext(request), (trx) =>
    storeTwoStep(trx, deps, owner.id, pending.secret, step, recovery.hashes),
  );
  pendingTwoStep = null;
  return { recoveryCodes: recovery.codes };
}

/** Step 4: a one-time enrollment code; the app enrolls this PC as the POS with it (0024). */
export async function setupDeviceCode(
  deps: AppDeps,
  request: FastifyRequest,
): Promise<SetupDeviceCodeResponse> {
  await assertInProgress(deps.db);
  const owner = await ownerRow(deps.db);
  if (!owner?.totp_enabled) {
    throw new AppError('PERMISSION_DENIED', 'Set up the owner and the 2-step code first');
  }
  const made = await withBusinessTx(deps.db, setupContext(request), (trx) =>
    createEnrollmentCode(trx, deps, 'console'),
  );
  return { code: made.code, expiresAt: made.expiresAt.toISOString() };
}

/** Step 5: everything is there → complete, locked for good; the token file is deleted. */
export async function completeSetup(deps: AppDeps, request: FastifyRequest): Promise<void> {
  const state = await assertInProgress(deps.db);
  const owner = await ownerRow(deps.db);
  const missing = [
    ...((await company.getCompany(deps.db)) ? [] : ['company']),
    ...(owner ? [] : ['owner']),
    ...(owner?.totp_enabled ? [] : ['twoStep']),
    ...((await setupPosDevice(deps.db, state.started_at)) ? [] : ['posDevice']),
  ];
  if (missing.length > 0) {
    throw new AppError('PERMISSION_DENIED', 'Setup is not finished', { missing });
  }
  await withBusinessTx(deps.db, setupContext(request), (trx) =>
    trx.updateTable('sys.setup_state').set({ state: 'complete' }).where('id', '=', 1).execute(),
  );
  await unlink(deps.setupTokenFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT')
      request.log.error({ err: error }, 'could not delete the setup token');
  });
}
