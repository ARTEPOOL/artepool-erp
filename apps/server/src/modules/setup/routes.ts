import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  SaveCompanyRequest,
  SaveLogoRequest,
  SetupOwnerRequest,
  SetupStartRequest,
  SetupTwoStepConfirmRequest,
} from '@artepool/shared/contracts';
import { defineRoute } from '../../platform/http/route';
import * as setup from './service';

const SetupLogoRequest = SaveLogoRequest.omit({ rowVersion: true });

/**
 * The first-run wizard (decision 0102). "Public" for the session guard because nobody is signed in
 * yet; every handler first checks the server PC's own address and the installer's token.
 */
export function registerSetupRoutes(app: FastifyInstance): void {
  const deps = app.deps;
  const open = { kind: 'public' } as const;
  const guarded =
    <T>(work: (request: FastifyRequest) => Promise<T>) =>
    async (request: FastifyRequest): Promise<T> => {
      await setup.assertSetupAccess(deps, request);
      return work(request);
    };

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/setup/status',
    access: open,
    handler: ({ request }) => guarded(() => setup.setupStatus(deps))(request),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/setup/start',
    access: open,
    body: SetupStartRequest,
    handler: async ({ request }) => {
      await guarded((r) => setup.startSetup(deps, r))(request);
      return setup.setupStatus(deps);
    },
  });
  defineRoute(app, {
    method: 'PUT',
    url: '/api/v1/setup/company',
    access: open,
    body: SaveCompanyRequest,
    handler: ({ request, body }) => guarded((r) => setup.saveSetupCompany(deps, r, body))(request),
  });
  defineRoute(app, {
    method: 'PUT',
    url: '/api/v1/setup/company/logo',
    access: open,
    body: SetupLogoRequest,
    handler: ({ request, body }) =>
      guarded((r) => setup.saveSetupLogo(deps, r, body.logo))(request),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/setup/owner',
    access: open,
    body: SetupOwnerRequest,
    handler: async ({ request, body }) => {
      await guarded((r) => setup.createSetupOwner(deps, r, body))(request);
      return setup.setupStatus(deps);
    },
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/setup/two-step/start',
    access: open,
    handler: ({ request }) => guarded(() => setup.startSetupTwoStep(deps))(request),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/setup/two-step/confirm',
    access: open,
    body: SetupTwoStepConfirmRequest,
    handler: ({ request, body }) =>
      guarded((r) => setup.confirmSetupTwoStep(deps, r, body.code))(request),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/setup/device-code',
    access: open,
    handler: ({ request }) => guarded((r) => setup.setupDeviceCode(deps, r))(request),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/setup/complete',
    access: open,
    handler: async ({ request }) => {
      await guarded((r) => setup.completeSetup(deps, r))(request);
      return { state: 'complete' as const };
    },
  });
}
