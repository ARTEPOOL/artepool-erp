/**
 * Typed calls to the API through the bridge. The session token lives here, in memory only: it
 * is never written to disk or browser storage, so closing the app always ends the sign-in.
 */
import type { BridgeRequest } from '@artepool/shared/contracts';
import type { Bridge } from './bridge';

/** Problems found on this PC rather than by the server. */
export type LocalErrorCode = 'SERVER_UNREACHABLE' | 'SERVER_UNTRUSTED' | 'DEVICE_NOT_ENROLLED';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    /** A server error code (`@artepool/shared/errors`) or a local one. */
    readonly code: string,
    readonly status: number,
    /** Values for the message, e.g. `{ minutes: 15 }`. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }

  /** The server could not be asked: nothing was done, and trying again is safe. */
  get isConnection(): boolean {
    return this.code === 'SERVER_UNREACHABLE' || this.code === 'SERVER_UNTRUSTED';
  }
}

interface ErrorBody {
  error?: { code?: string; details?: Record<string, unknown> };
}

export interface CallOptions {
  /** Automatic refreshes: they do not count as the person being active (idle lock). */
  background?: boolean;
  /** Required by saves; reuse the same key when retrying the same operation. */
  idempotencyKey?: string;
}

export class ApiClient {
  private token: string | null = null;
  private readonly listeners = new Set<(error: ApiError) => void>();

  constructor(private readonly bridge: Bridge) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  get hasSession(): boolean {
    return this.token !== null;
  }

  /** Called for every failed call (the sign-in flow reacts to session and device problems). */
  onError(listener: (error: ApiError) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get<T>(path: string, options: CallOptions = {}): Promise<T> {
    return this.send<T>({ method: 'GET', path }, options);
  }

  post<T>(path: string, body?: unknown, options: CallOptions = {}): Promise<T> {
    return this.send<T>({ method: 'POST', path, body: body ?? {} }, options);
  }

  patch<T>(path: string, body: unknown, options: CallOptions = {}): Promise<T> {
    return this.send<T>({ method: 'PATCH', path, body }, options);
  }

  put<T>(path: string, body: unknown, options: CallOptions = {}): Promise<T> {
    return this.send<T>({ method: 'PUT', path, body }, options);
  }

  private async send<T>(
    request: Pick<BridgeRequest, 'method' | 'path' | 'body'>,
    options: CallOptions,
  ): Promise<T> {
    const answer = await this.bridge.request({
      ...request,
      ...(this.token ? { token: this.token } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.background ? { background: true } : {}),
    });
    let error: ApiError;
    if (answer.kind === 'response') {
      if (answer.status >= 200 && answer.status < 300) return answer.body as T;
      const body = answer.body as ErrorBody | null;
      error = new ApiError(
        body?.error?.code ?? 'INTERNAL',
        answer.status,
        body?.error?.details ?? {},
      );
    } else if (answer.kind === 'not_enrolled') {
      error = new ApiError('DEVICE_NOT_ENROLLED', 0);
    } else {
      error = new ApiError(
        answer.kind === 'untrusted' ? 'SERVER_UNTRUSTED' : 'SERVER_UNREACHABLE',
        0,
      );
    }
    this.listeners.forEach((listener) => listener(error));
    throw error;
  }
}

/** A fresh key for one save operation (kept while retrying that same save). */
export const newOperationKey = (): string => crypto.randomUUID();
