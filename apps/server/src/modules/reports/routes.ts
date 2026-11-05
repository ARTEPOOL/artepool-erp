import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DashboardQuery, ReconciliationRequest } from '@artepool/shared/contracts';
import { AppError } from '../../platform/errors/app-error';
import { contextOf } from '../../platform/http/context';
import { defineRoute } from '../../platform/http/route';
import { renderPdf } from '../printing/render';
import { ownerDashboard } from './dashboard';
import { reconciliationById, runReconciliation } from './reconciliation';
import { reconciliationHtml } from './reconciliation-print';

const Params = z.object({ id: z.string().regex(/^\d{1,18}$/) });

/** The owner's dashboard (decision 0081): owner only, enforced here, not only hidden. */
export function registerReportsRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/reports/owner-dashboard',
    access: { kind: 'permission', permission: 'reports.owner_dashboard' },
    query: DashboardQuery,
    handler: ({ query }) => ownerDashboard(app.deps.db, query),
  });

  // The reconciliation report (M7, decision 0119): owner and accountant, enforced here.
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/reports/reconciliation',
    access: { kind: 'permission', permission: 'reports.reconciliation' },
    body: ReconciliationRequest,
    handler: ({ body, request }) =>
      runReconciliation(app.deps.db, contextOf(request), request.auth, body),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/reports/reconciliation/:id/pdf',
    access: { kind: 'permission', permission: 'reports.reconciliation' },
    params: Params,
    handler: async ({ params, request }) => {
      const report = await reconciliationById(app.deps.db, BigInt(params.id));
      if (!report) throw new AppError('NOT_FOUND', 'No such reconciliation report');
      const html = await reconciliationHtml(app.deps.db, report, request.auth);
      return {
        fileName: `reconciliation-${report.from}-${report.to}.pdf`,
        mime: 'application/pdf',
        dataBase64: (await renderPdf(html)).toString('base64'),
      };
    },
  });
}
