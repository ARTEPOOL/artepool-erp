/**
 * What a route needs before its handler runs. Every route must declare one (the server refuses
 * to start otherwise), so a permission check can never be forgotten (CLAUDE.md, definition of
 * done: "Permissions checked on the server").
 */
export type Access =
  /** No device needed: only the health check and the first steps of device enrollment. */
  | { readonly kind: 'public' }
  /** An enrolled, active PC; nobody signed in yet (sign-in, the PIN user list). */
  | { readonly kind: 'device' }
  /**
   * An enrolled PC and a signed-in user, for actions every signed-in user may take on their own
   * account (sign out, lock, change own password).
   */
  | {
      readonly kind: 'session';
      /** `second_factor`: only the short session waiting for the 2-step code. Default `full`. */
      readonly stage?: 'second_factor' | 'full';
      /** Also allowed while the screen is locked (unlock, sign out). */
      readonly allowLocked?: boolean;
      /** Also allowed before the user has chosen their own password/PIN or set up 2-step. */
      readonly allowPending?: boolean;
    }
  /** An enrolled PC, a full signed-in session, and this permission (`module.action`). */
  | { readonly kind: 'permission'; readonly permission: string };

export const PERMISSION_CODE = /^[a-z_]+(\.[a-z_]+)+$/;

/** An enrolled PC that passed the device check. */
export interface DeviceInfo {
  readonly id: bigint;
  readonly code: string;
  readonly kind: 'pos' | 'office' | 'warehouse' | 'server';
  readonly branchId: bigint;
  readonly keyExpiresAt: Date;
}

/** The signed-in user of a request that passed the session check. */
export interface AuthInfo {
  readonly sessionId: bigint;
  readonly userId: bigint;
  readonly username: string;
  readonly signInMethod: 'pin' | 'password' | 'password_totp';
  readonly authMethod: 'password' | 'password_totp' | 'recovery_code' | 'pin';
  readonly stage: 'second_factor' | 'full';
  readonly locked: boolean;
  /** What the user must do before anything else, if anything. */
  readonly pending: 'credential_change' | 'two_step_setup' | null;
  /** Filled for `permission` routes. */
  permissions: ReadonlySet<string>;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    device: DeviceInfo | null;
    auth: AuthInfo | null;
  }
}
