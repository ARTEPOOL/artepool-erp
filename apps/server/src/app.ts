import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DestinationStream } from 'pino';
import { registerGuard } from './platform/auth/guard';
import type { ServerConfig } from './platform/config';
import { AppError, toAppError } from './platform/errors/app-error';
import { registerApprovalRoutes } from './modules/approvals/routes';
import { registerAuditRoutes } from './modules/audit/routes';
import { registerAuthRoutes } from './modules/auth/routes';
import { registerBackupRoutes } from './modules/backup/routes';
import { registerUpdateRoutes } from './modules/updates/routes';
import { registerHealthRoutes } from './modules/health/routes';
import { registerCompanyRoutes } from './modules/company/routes';
import { registerPrintingRoutes } from './modules/printing/routes';
import { registerDeviceRoutes } from './modules/devices/routes';
import { registerImportRoutes } from './modules/imports/routes';
import { registerInventoryRoutes } from './modules/inventory/routes';
import { registerSalesRoutes } from './modules/sales/routes';
import { registerPosRoutes } from './modules/pos/routes';
import { registerCashRoutes } from './modules/cash/routes';
import { registerItemRoutes } from './modules/items/routes';
import { registerLedgerRoutes } from './modules/ledger/routes';
import { registerListRoutes } from './modules/lists/routes';
import { registerPartyRoutes } from './modules/parties/routes';
import { registerReportsRoutes } from './modules/reports/routes';
import { registerSettingsRoutes } from './modules/settings/routes';
import { registerUserRoutes } from './modules/users/routes';
import type { AppDeps } from './platform/http/deps';
import { REDACT_PATHS, safeErrorSerializer } from './platform/http/logging';
import { registerHealth } from './routes/health';
import { registerSetupRoutes } from './modules/setup/routes';

export interface AppOptions extends Pick<ServerConfig, 'logLevel'> {
  /** Where logs go (tests capture them to prove that no secret is ever logged). */
  logStream?: DestinationStream;
  /** Server certificate and key: the API is served over TLS 1.3 only (never plain HTTP). */
  https?: { cert: string; key: string };
}

/** Fastify's own request errors (bad JSON, body too large, …) are the client's fault. */
function isClientError(error: unknown): boolean {
  const e = error as { statusCode?: unknown; code?: unknown };
  return (
    typeof e.statusCode === 'number' &&
    e.statusCode >= 400 &&
    e.statusCode < 500 &&
    typeof e.code === 'string' &&
    e.code.startsWith('FST_')
  );
}

export function buildApp(options: AppOptions, deps: AppDeps): FastifyInstance {
  const app = Fastify({
    ...(options.https
      ? {
          https: {
            cert: options.https.cert,
            key: options.https.key,
            minVersion: 'TLSv1.3' as const,
            maxVersion: 'TLSv1.3' as const,
          },
        }
      : {}),
    logger: {
      level: options.logLevel,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      serializers: { err: safeErrorSerializer },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    genReqId: () => randomUUID(),
    exposeHeadRoutes: false,
  }) as unknown as FastifyInstance;
  app.decorate('deps', deps);

  // bigint (ids, money in fils) is sent as exact text, never as a JSON number.
  app.setReplySerializer((payload) =>
    JSON.stringify(payload, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );

  app.setErrorHandler((error, request, reply) => {
    const appError = isClientError(error)
      ? new AppError('VALIDATION_FAILED', 'Malformed request', {}, { cause: error })
      : toAppError(error);
    const log = appError.httpStatus >= 500 ? request.log.error : request.log.warn;
    log.call(request.log, { err: error, code: appError.code }, appError.message);
    if (appError.code === 'RATE_LIMITED' && typeof appError.details.seconds === 'number') {
      void reply.header('retry-after', String(appError.details.seconds));
    }
    return reply
      .code(appError.httpStatus)
      .send({ error: { code: appError.code, details: appError.details } });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', details: {} } }),
  );

  registerGuard(app, deps);
  registerHealth(app, deps.db);
  registerAuthRoutes(app);
  registerDeviceRoutes(app);
  registerUserRoutes(app);
  registerApprovalRoutes(app);
  registerAuditRoutes(app);
  registerCompanyRoutes(app);
  registerSetupRoutes(app);
  registerPrintingRoutes(app);
  registerSettingsRoutes(app);
  registerBackupRoutes(app);
  registerUpdateRoutes(app);
  registerHealthRoutes(app);
  registerReportsRoutes(app);
  registerLedgerRoutes(app);
  registerInventoryRoutes(app);
  registerSalesRoutes(app);
  registerPosRoutes(app);
  registerCashRoutes(app);
  registerItemRoutes(app);
  registerPartyRoutes(app);
  registerListRoutes(app);
  registerImportRoutes(app);
  return app;
}
