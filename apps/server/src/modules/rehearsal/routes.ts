import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../platform/errors/app-error';
import { defineRoute, defineWrite } from '../../platform/http/route';
import { renderPdf } from '../printing/render';
import { reconciliationHtml } from '../reports/reconciliation-print';
import * as rehearsal from './service';

const Params = z.object({ id: z.string().regex(/^[1-9][0-9]{0,17}$/) });

/**
 * System health → the automated rehearsal (decision 0119): the owner starts it and sees it; the
 * reconciliation report of a finished rehearsal prints for the owner and the accountant.
 */
export function registerRehearsalRoutes(app: FastifyInstance): void {
  const deps = app.deps;
  const owner = { kind: 'permission', permission: 'system.rehearsal' } as const;
  const free = () => rehearsal.freeBytes(deps.health.dataDir);

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/system/rehearsals',
    access: owner,
    handler: async () => rehearsal.rehearsals(deps.db, await free()),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/system/rehearsals',
    access: owner,
    reason: () => 'the owner starts the automated rehearsal',
    // Read before the transaction: a slow disk never holds it open.
    prepare: () => free(),
    handler: async ({ trx, prepared }) => ({
      status: 201,
      body: await rehearsal.requestRehearsal(trx, prepared),
    }),
    // The updater starts it at once, as for "Install now" (0115).
    afterCommit: (request) => deps.updates.wake((message) => request.log.warn(message)),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/system/rehearsals/:id/reconciliation/pdf',
    access: { kind: 'permission', permission: 'reports.reconciliation' },
    params: Params,
    handler: async ({ params, request }) => {
      const run = await rehearsal.rehearsalById(deps.db, BigInt(params.id));
      const report = run?.result?.reconciliation;
      if (!run || !report)
        throw new AppError('NOT_FOUND', 'No reconciliation report for this rehearsal');
      const html = await reconciliationHtml(
        deps.db,
        { id: `rehearsal-${run.id}`, ...report },
        request.auth,
        { rehearsal: true },
      );
      return {
        fileName: `rehearsal-${run.id}-reconciliation-${report.from}.pdf`,
        mime: 'application/pdf',
        dataBase64: (await renderPdf(html)).toString('base64'),
      };
    },
  });
}
