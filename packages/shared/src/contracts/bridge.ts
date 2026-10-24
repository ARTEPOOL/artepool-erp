/**
 * The bridge between the screens and the PC's native side (architecture §6, decision 0024).
 *
 * The screens never open a network connection themselves and never see the device key. They ask
 * the native side to send a request; it adds the device key and the app version, connects with
 * TLS 1.3 trusting only the ARTÉPOOL CA, and hands back the answer.
 *
 * - In the Windows app the native side is the Rust layer (Tauri, T11).
 * - In development in a browser it is the Vite dev server (`@artepool/dev-bridge`).
 */
import { z } from 'zod';

/** Only API paths (and the health check) can be requested: the bridge is not a general proxy. */
export const BridgePath = z
  .string()
  .max(512)
  .regex(/^\/(api\/v1\/[A-Za-z0-9\-._~/%]*|health)(\?[A-Za-z0-9\-._~%&=+]*)?$/)
  .refine((path) => !path.split('?')[0]!.split('/').includes('..'), 'no dot segments');

export const BridgeRequest = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT']),
  path: BridgePath,
  body: z.unknown().optional(),
  /** The session token, kept in memory by the screens only. */
  token: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  /** One per business operation, so a retry after a lost answer is not done twice. */
  idempotencyKey: z.uuid().optional(),
  /** Automatic refreshes: they do not keep a session awake (idle lock). */
  background: z.boolean().optional(),
});
export type BridgeRequest = z.infer<typeof BridgeRequest>;

export type BridgeResponse =
  /** The server answered (any HTTP status). JSON bodies are parsed; others are text (CSV). */
  | { kind: 'response'; status: number; contentType: string; body: unknown }
  /** No answer: the server PC is off, the network is down, or the address is wrong. */
  | { kind: 'unreachable' }
  /** Something answered that is not the ARTÉPOOL server (its certificate is not from our CA). */
  | { kind: 'untrusted' }
  /** This PC has no device key yet: it must be enrolled first. */
  | { kind: 'not_enrolled' };

/**
 * The first-run wizard (decision 0102): whether this PC holds the installer's setup token (only
 * the server PC, right after installation, and only for Windows administrators), and how it
 * reaches its own server. The token itself never reaches the screens.
 */
export interface SetupInfo {
  available: boolean;
  /** e.g. `127.0.0.1:3100`: the server PC talks to its own server. */
  serverAddress: string | null;
  /**
   * The Windows build of this PC (decision 0106), or null when unknown: below 22000 is Windows 10,
   * which no longer gets free security updates (a warning, never a block).
   */
  windowsBuild: number | null;
}

/** Windows 11 starts at build 22000. */
export const WINDOWS_11_BUILD = 22000;

/** Only the setup endpoints go through the setup channel. */
export const SetupRequest = z.object({
  method: z.enum(['GET', 'POST', 'PUT']),
  path: z
    .string()
    .max(128)
    .regex(/^\/api\/v1\/setup\/[a-z0-9/-]+$/),
  body: z.unknown().optional(),
});
export type SetupRequest = z.infer<typeof SetupRequest>;

export interface LocalDevice {
  enrolled: boolean;
  /** The server this PC is enrolled with, e.g. `https://artepool-server:3100`. */
  serverUrl: string | null;
  /** As enrolled (shown at the bottom of the sign-in screen even when the server is down). */
  device: { code: string; name: string; kind: string } | null;
  /** The Windows computer name, suggested as the device code when enrolling. */
  suggestedCode: string;
}

/** What a person types on the "enroll this PC" screen. */
export const EnrollInput = z.object({
  /** `artepool-server`, `192.168.1.10`, `https://artepool-server:3100`, … */
  serverAddress: z.string().trim().min(1).max(200),
  code: z.string().trim().min(1).max(32),
  deviceCode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  deviceName: z.string().trim().min(1).max(100),
  deviceKind: z.enum(['pos', 'office', 'warehouse']),
});
export type EnrollInput = z.infer<typeof EnrollInput>;

export type EnrollFailure =
  /** The server address cannot be understood. */
  | 'invalid_address'
  /** Nothing answered at that address. */
  | 'unreachable'
  /**
   * The answer did not prove knowledge of the code: the code is wrong or expired, or this is
   * not the genuine ARTÉPOOL server. The PC refuses to trust it.
   */
  | 'not_genuine'
  /** The server refused the code at the last step (expired meanwhile, or too many attempts). */
  | 'code_rejected'
  /** Another active PC already has this computer name; the code stays usable. */
  | 'code_taken'
  /** Too many attempts from this PC; wait a minute. */
  | 'rate_limited'
  /** The server could not enroll right now. */
  | 'unavailable';

export type EnrollOutcome =
  | {
      ok: true;
      serverUrl: string;
      device: { id: string; code: string; name: string; kind: string };
    }
  | { ok: false; reason: EnrollFailure };
