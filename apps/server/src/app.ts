import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DestinationStream } from 'pino';
import { registerGuard } from './platform/auth/guard';
import type { ServerConfig } from './platform/config';
import { AppError, toAppError } from './platform/errors/app-error';
import { registerApprovalRoutes } from './modules/approvals/routes';
import { registerAuditRoutes } from './modules/audit/routes';
import { registerAuthRoutes } from './modules/auth/routes';
import { registerDeviceRoutes } from './modules/devices/routes';
import { registerUserRoutes } from './modules/users/routes';
import type { AppDeps } from './platform/http/deps';
import { REDACT_PATHS, safeErrorSerializer } from './platform/http/logging';
import { registerHealth } from './routes/health';

export interface AppOptions extends Pick<ServerConfig, 'logLevel'> {
  /** Where logs go (tests capture them to prove that no secret is ever logged). */
  logStream?: DestinationStream;
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
    logger: {
      level: options.logLevel,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      serializers: { err: safeErrorSerializer },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    genReqId: () => randomUUID(),
    exposeHeadRoutes: false,
  });
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
  return app;
}
