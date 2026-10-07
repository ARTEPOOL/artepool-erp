import type { FastifyInstance } from 'fastify';
import {
  ChangePasswordRequest,
  ChangePinRequest,
  PinSignInRequest,
  RecoverPasswordRequest,
  SecondFactorRequest,
  SignInRequest,
  TwoStepConfirmRequest,
  UnlockRequest,
} from '@artepool/shared/contracts';
import { defineRoute } from '../../platform/http/route';
import * as auth from './service';

/**
 * Sign-in and own-account routes. They manage their own transactions (attempts must be recorded
 * even when they fail), so they are not idempotent saves; they never change business records.
 */
export function registerAuthRoutes(app: FastifyInstance): void {
  const deps = app.deps;
  const base = '/api/v1/auth';
  const own = { kind: 'session', allowPending: true } as const;

  defineRoute(app, {
    method: 'GET',
    url: `${base}/pin-users`,
    access: { kind: 'device' },
    handler: ({ request }) => auth.pinUsers(deps, request),
  });
  defineRoute(app, {
    method: 'POST',
    url: `${base}/sign-in`,
    access: { kind: 'device' },
    body: SignInRequest,
    handler: ({ request, body }) => auth.signInWithPassword(deps, request, body),
  });
  defineRoute(app, {
    method: 'POST',
    url: `${base}/pin-sign-in`,
    access: { kind: 'device' },
    body: PinSignInRequest,
    handler: ({ request, body }) => auth.signInWithPin(deps, request, body),
  });
  defineRoute(app, {
    method: 'POST',
    url: `${base}/recover-password`,
    access: { kind: 'device' },
    body: RecoverPasswordRequest,
    handler: ({ request, body }) => auth.recoverPassword(deps, request, body),
  });
  defineRoute(app, {
    method: 'POST',
    url: `${base}/second-factor`,
    access: { kind: 'session', stage: 'second_factor' },
    body: SecondFactorRequest,
    handler: ({ request, body }) => auth.verifySecondFactor(deps, request, body),
  });
  defineRoute(app, {
    method: 'POST',
    url: `${base}/two-step/start`,
    access: own,
    handler: ({ request }) => Promise.resolve(auth.startTwoStep(request)),
  });
  defineRoute(app, {
    method: 'POST',
    url: `${base}/two-step/confirm`,
    access: own,
    body: TwoStepConfirmRequest,
    handler: ({ request, body }) => auth.confirmTwoStep(deps, request, body.code),
  });
  defineRoute(app, {
    method: 'POST',
    url: `${base}/change-password`,
    access: own,
    body: ChangePasswordRequest,
    handler: ({ request, body }) => auth.changePassword(deps, request, body),
  });
  defineRoute(app, {
    method: 'POST',
    url: `${base}/change-pin`,
    access: own,
    body: ChangePinRequest,
    handler: ({ request, body }) => auth.changePin(deps, request, body),
  });
  defineRoute(app, {
    method: 'POST',
    url: `${base}/lock`,
    access: { kind: 'session', allowLocked: true, allowPending: true },
    handler: ({ request }) => auth.lock(deps, request),
  });
  defineRoute(app, {
    method: 'POST',
    url: `${base}/unlock`,
    access: { kind: 'session', allowLocked: true, allowPending: true },
    body: UnlockRequest,
    handler: ({ request, body }) => auth.unlock(deps, request, body.secret),
  });
  defineRoute(app, {
    method: 'POST',
    url: `${base}/sign-out`,
    access: { kind: 'session', stage: 'any', allowLocked: true, allowPending: true },
    handler: async ({ request, reply }) => {
      await auth.signOut(deps, request);
      return reply.code(204).send();
    },
  });
  defineRoute(app, {
    method: 'GET',
    url: `${base}/me`,
    access: own,
    handler: ({ request }) => auth.me(deps, request),
  });
}
