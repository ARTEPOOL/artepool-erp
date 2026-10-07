import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './platform/config';
import type { Db } from './platform/db/pool';
import { toAppError } from './platform/errors/app-error';
import { registerHealth } from './routes/health';

/** Never log secrets (golden rule 13). */
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.pin',
  '*.token',
  '*.secret',
  '*.totp',
];

export function buildApp(config: Pick<ServerConfig, 'logLevel'>, db: Db): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel, redact: { paths: REDACT, censor: '[redacted]' } },
  });

  // bigint (ids, money in fils) is sent as exact text, never as a JSON number.
  app.setReplySerializer((payload) =>
    JSON.stringify(payload, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );

  app.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);
    request.log.error({ err: error, code: appError.code }, appError.message);
    return reply
      .code(appError.httpStatus)
      .send({ error: { code: appError.code, details: appError.details } });
  });

  registerHealth(app, db);
  return app;
}
