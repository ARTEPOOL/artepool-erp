import type { FastifyRequest } from 'fastify';
import type { RequestContext } from '../db/tx';

/** The built-in SYSTEM user: acts for requests made before anyone has signed in. */
export const SYSTEM_USER_ID = 1n;

/** Who, from which PC and session, for the audit log of this request's transaction. */
export function contextOf(
  request: FastifyRequest,
  extra: Partial<RequestContext> = {},
): RequestContext {
  return {
    userId: request.auth?.userId ?? SYSTEM_USER_ID,
    deviceId: request.device?.id ?? null,
    sessionId: request.auth?.sessionId ?? null,
    requestId: request.id,
    clientIp: request.ip,
    ...extra,
  };
}

/** A single header value, or undefined. */
export function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Compares versions like 1.2.3 numerically: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
