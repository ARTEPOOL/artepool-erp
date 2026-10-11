import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { DeactivateRequest, IdText, ReactivateRequest } from '@artepool/shared/contracts';
import { withBusinessTx } from '../db/tx';
import type { DB } from '../db/schema.generated';
import { AppError } from '../errors/app-error';
import {
  findStored,
  requestHash,
  store,
  type IdempotencyScope,
  type StoredResponse,
} from '../idempotency';
import type { Access } from './access';
import { contextOf, header } from './context';
import { IDEMPOTENCY_HEADER } from './logging';

const DeactivateParams = z.object({ id: IdText });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RouteInput<P, Q, B> {
  params: P;
  query: Q;
  body: B;
  request: FastifyRequest;
  reply: FastifyReply;
}

interface Schemas<P, Q, B> {
  params?: z.ZodType<P>;
  query?: z.ZodType<Q>;
  body?: z.ZodType<B>;
}

/** Validates one part of the request; the client gets field paths only, never the values. */
function parse<T>(schema: z.ZodType<T> | undefined, value: unknown, part: string): T {
  if (!schema) return undefined as T;
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new AppError('VALIDATION_FAILED', `Invalid ${part}`, {
    part,
    issues: result.error.issues.map((i) => ({ path: i.path.map(String), code: i.code })),
  });
}

function inputOf<P, Q, B>(
  schemas: Schemas<P, Q, B>,
  request: FastifyRequest,
  reply: FastifyReply,
): RouteInput<P, Q, B> {
  return {
    params: parse(schemas.params, request.params, 'params'),
    query: parse(schemas.query, request.query, 'query'),
    body: parse(schemas.body, request.body, 'body'),
    request,
    reply,
  };
}

/**
 * A route whose handler manages its own work: reads, and the sign-in / enrollment steps that
 * run before anyone is signed in. The access is required by the type and by the guard.
 */
export function defineRoute<P = undefined, Q = undefined, B = undefined, R = unknown>(
  app: FastifyInstance,
  def: Schemas<P, Q, B> & {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH';
    url: string;
    access: Access;
    handler: (input: RouteInput<P, Q, B>) => Promise<R>;
  },
): void {
  app.route({
    method: def.method,
    url: def.url,
    config: { access: def.access },
    handler: async (request, reply) => def.handler(inputOf(def, request, reply)),
  });
}

export interface WriteResult<R> {
  body: R;
  status?: number;
  /**
   * What a retry with the same idempotency key gets back. Use it when `body` holds a one-time
   * secret (temporary password, device key, codes): the secret is never stored.
   */
  replay?: unknown;
}

/**
 * A business write by a signed-in user: ONE database transaction with the request context
 * (golden rules 4 and 6), and an `Idempotency-Key` so a retried request returns the first answer
 * instead of doing the work twice.
 */
export function defineWrite<P = undefined, Q = undefined, B = undefined, R = unknown>(
  app: FastifyInstance,
  def: Schemas<P, Q, B> & {
    method: 'POST' | 'PUT' | 'PATCH';
    url: string;
    access: Extract<Access, { kind: 'session' } | { kind: 'permission' }>;
    /** Reason written to every audit entry of the transaction. */
    reason?: (input: RouteInput<P, Q, B>) => string | null;
    /** Largest request body in bytes, when the default 1 MB is not enough (Excel imports). */
    bodyLimit?: number;
    handler: (input: RouteInput<P, Q, B> & { trx: Transaction<DB> }) => Promise<WriteResult<R>>;
  },
): void {
  app.route({
    method: def.method,
    url: def.url,
    config: { access: def.access },
    ...(def.bodyLimit ? { bodyLimit: def.bodyLimit } : {}),
    handler: async (request, reply) => {
      const key = header(request, IDEMPOTENCY_HEADER);
      if (!key || !UUID.test(key)) {
        throw new AppError('VALIDATION_FAILED', 'Idempotency-Key header missing or malformed', {
          part: 'headers',
          issues: [{ path: [IDEMPOTENCY_HEADER], code: 'invalid_format' }],
        });
      }
      const input = inputOf(def, request, reply);
      const scope: IdempotencyScope = {
        key: key.toLowerCase(),
        userId: request.auth!.userId,
        deviceId: request.device!.id,
        endpoint: `${request.method} ${request.url}`.slice(0, 200),
        requestHash: requestHash(request.method, request.url, request.body),
      };
      let response: StoredResponse & { live?: unknown };
      try {
        response = await withBusinessTx(
          app.deps.db,
          contextOf(request, { reason: def.reason?.(input) ?? null }),
          async (trx) => {
            const stored = await findStored(trx, scope);
            if (stored) return stored;
            const result = await def.handler({ ...input, trx });
            const status = result.status ?? 200;
            await store(trx, scope, { status, body: result.replay ?? result.body });
            return { status, body: result.replay ?? result.body, live: result.body };
          },
        );
      } catch (error) {
        // The same request arrived twice at once: the other one committed first.
        const cause = (error as { cause?: { constraint?: string } }).cause;
        if (cause?.constraint !== 'idempotency_keys_pkey') throw error;
        response = await withBusinessTx(app.deps.db, contextOf(request), async (trx) => {
          const stored = await findStored(trx, scope);
          if (!stored) throw error;
          return stored;
        });
      }
      return reply.code(response.status).send(response.live ?? response.body);
    },
  });
}

/**
 * `POST <base>/:id/deactivate` (with a reason, written to the audit log) and
 * `POST <base>/:id/reactivate` for master data: nothing is ever deleted (golden rule 2,
 * decision 0037).
 */
export function defineActivation<R>(
  app: FastifyInstance,
  def: {
    base: string;
    access: Extract<Access, { kind: 'permission' }>;
    setActive: (
      trx: Transaction<DB>,
      id: bigint,
      active: boolean,
      rowVersion: number,
      /** The signed-in user's rights, for answers that depend on them (items show costs). */
      auth: { permissions: ReadonlySet<string> } | null,
    ) => Promise<R>;
  },
): void {
  const params = DeactivateParams;
  defineWrite(app, {
    method: 'POST',
    url: `${def.base}/:id/deactivate`,
    access: def.access,
    params,
    body: DeactivateRequest,
    reason: ({ body }) => body.reason,
    handler: async ({ trx, request, params: p, body }) => ({
      body: await def.setActive(trx, BigInt(p.id), false, body.rowVersion, request.auth),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: `${def.base}/:id/reactivate`,
    access: def.access,
    params,
    body: ReactivateRequest,
    handler: async ({ trx, request, params: p, body }) => ({
      body: await def.setActive(trx, BigInt(p.id), true, body.rowVersion, request.auth),
    }),
  });
}
