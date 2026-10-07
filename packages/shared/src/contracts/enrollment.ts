/**
 * Device enrollment protocol v1 (decision 0024). The one-time code proves both sides:
 *
 *  1. hello:    PC → server  { clientNonce }
 *               server → PC  { caCertificatePem, serverNonce, keySalt, serverProof }
 *  2. The PC derives codeKey = Argon2id(code, keySalt) and checks serverProof. Only the genuine
 *     server (which holds codeKey) can produce it, so the PC may now trust caCertificatePem.
 *  3. complete: over TLS that trusts only that CA, PC → server { …, deviceKeyHash, clientProof }.
 *     The server checks clientProof (only someone with the code can make it) and stores the PC.
 *
 * The code itself never travels. The PC makes its own 256-bit device key and sends only its
 * SHA-256, so the server never holds a device key in a form that could be copied from its data.
 */
import { z } from 'zod';

export const ENROLL_PROTOCOL = 'artepool-enroll-v1';

/** Fixed Argon2id settings for codeKey (part of the protocol; both sides must match). */
export const ENROLL_ARGON2 = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLength: 32,
} as const;

/** 32 random bytes as base64url (43 characters). */
const Bytes32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const EnrollHelloRequest = z.object({ clientNonce: Bytes32 });
export type EnrollHelloRequest = z.infer<typeof EnrollHelloRequest>;

export interface EnrollHelloResponse {
  protocol: typeof ENROLL_PROTOCOL;
  caCertificatePem: string;
  serverNonce: string;
  /** 16 bytes, base64url. */
  keySalt: string;
  /** HMAC-SHA256(codeKey, "server\n" + transcript), base64url. */
  serverProof: string;
}

export const DEVICE_KINDS = ['pos', 'office', 'warehouse', 'server'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const EnrollCompleteRequest = z.object({
  clientNonce: Bytes32,
  serverNonce: Bytes32,
  /** The Windows computer name, e.g. COUNTER-01. */
  deviceCode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  deviceName: z.string().trim().min(1).max(100),
  deviceKind: z.enum(DEVICE_KINDS),
  /** SHA-256 of the PC's own 256-bit device key, base64url. */
  deviceKeyHash: Bytes32,
  /** HMAC-SHA256(codeKey, clientMessage(...)), base64url. */
  clientProof: Bytes32,
});
export type EnrollCompleteRequest = z.infer<typeof EnrollCompleteRequest>;

export interface EnrollCompleteResponse {
  device: { id: string; code: string; name: string; kind: DeviceKind };
  /** ISO time when the device key must have been renewed. */
  keyExpiresAt: string;
}

/** The text both proofs are computed over. */
export function enrollTranscript(
  clientNonce: string,
  serverNonce: string,
  caSha256Hex: string,
): string {
  return `${ENROLL_PROTOCOL}\n${clientNonce}\n${serverNonce}\n${caSha256Hex}`;
}

export const serverProofMessage = (transcript: string): string => `server\n${transcript}`;

export function clientProofMessage(
  transcript: string,
  device: Pick<EnrollCompleteRequest, 'deviceCode' | 'deviceName' | 'deviceKind' | 'deviceKeyHash'>,
): string {
  return [
    'client',
    transcript,
    device.deviceCode,
    device.deviceKind,
    device.deviceName,
    device.deviceKeyHash,
  ].join('\n');
}

export const RenewKeyRequest = z.object({ newKeyHash: Bytes32 });
export type RenewKeyRequest = z.infer<typeof RenewKeyRequest>;

export interface RenewKeyResponse {
  renewed: boolean;
  keyExpiresAt: string;
}
