import type { FastifyInstance } from 'fastify';
import { DashboardQuery } from '@artepool/shared/contracts';
import { defineRoute } from '../../platform/http/route';
import { ownerDashboard } from './dashboard';

/** The owner's dashboard (decision 0081): owner only, enforced here, not only hidden. */
export function registerReportsRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/reports/owner-dashboard',
    access: { kind: 'permission', permission: 'reports.owner_dashboard' },
    query: DashboardQuery,
    handler: ({ query }) => ownerDashboard(app.deps.db, query),
  });
}
