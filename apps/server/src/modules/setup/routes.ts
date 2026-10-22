import type { FastifyInstance } from 'fastify';
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
 * yet; every request first passes the setup check (the server PC's own address and the installer's
 * token), before its body is even read, so a caller without the token learns nothing.
 */
export function registerSetupRoutes(app: FastifyInstance): void {
  const deps = app.deps;
  const open = { kind: 'public' } as const;

  void app.register((scope, _options, done) => {
    scope.addHook('onRequest', (request) => setup.assertSetupAccess(deps, request));

    defineRoute(scope, {
      method: 'GET',
      url: '/api/v1/setup/status',
      access: open,
      handler: () => setup.setupStatus(deps),
    });
    defineRoute(scope, {
      method: 'POST',
      url: '/api/v1/setup/start',
      access: open,
      body: SetupStartRequest,
      handler: async ({ request }) => {
        await setup.startSetup(deps, request);
        return setup.setupStatus(deps);
      },
    });
    defineRoute(scope, {
      method: 'PUT',
      url: '/api/v1/setup/company',
      access: open,
      body: SaveCompanyRequest,
      handler: ({ request, body }) => setup.saveSetupCompany(deps, request, body),
    });
    defineRoute(scope, {
      method: 'PUT',
      url: '/api/v1/setup/company/logo',
      access: open,
      body: SetupLogoRequest,
      handler: ({ request, body }) => setup.saveSetupLogo(deps, request, body.logo),
    });
    defineRoute(scope, {
      method: 'POST',
      url: '/api/v1/setup/owner',
      access: open,
      body: SetupOwnerRequest,
      handler: async ({ request, body }) => {
        await setup.createSetupOwner(deps, request, body);
        return setup.setupStatus(deps);
      },
    });
    defineRoute(scope, {
      method: 'POST',
      url: '/api/v1/setup/two-step/start',
      access: open,
      handler: () => setup.startSetupTwoStep(deps),
    });
    defineRoute(scope, {
      method: 'POST',
      url: '/api/v1/setup/two-step/confirm',
      access: open,
      body: SetupTwoStepConfirmRequest,
      handler: ({ request, body }) => setup.confirmSetupTwoStep(deps, request, body.code),
    });
    defineRoute(scope, {
      method: 'POST',
      url: '/api/v1/setup/device-code',
      access: open,
      handler: ({ request }) => setup.setupDeviceCode(deps, request),
    });
    defineRoute(scope, {
      method: 'POST',
      url: '/api/v1/setup/complete',
      access: open,
      handler: async ({ request }) => {
        await setup.completeSetup(deps, request);
        return { state: 'complete' as const };
      },
    });
    done();
  });
}
