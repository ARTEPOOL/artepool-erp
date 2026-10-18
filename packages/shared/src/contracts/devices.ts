import { z } from 'zod';
import { DEVICE_KINDS, type DeviceKind } from './enrollment';

export interface DeviceListItem {
  id: string;
  code: string;
  name: string;
  kind: DeviceKind;
  status: 'active' | 'revoked';
  enrolledAt: string;
  keyExpiresAt: string;
  lastSeenAt: string | null;
  lastIp: string | null;
  appVersion: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  /** The PC making this request (cannot be revoked from itself). */
  isCurrent: boolean;
  /** The warehouse this PC uses; null = the default warehouse. */
  defaultWarehouseId: string | null;
  /** People who may sign in here without the phone code, until when (decision 0027). */
  trustedFor: TrustedPerson[];
  /** The POS drawer on this PC, if any, and its open shift (decision 0069). */
  drawer: DeviceDrawer | null;
}

export interface DeviceDrawer {
  id: string;
  code: string;
  openShift: { number: string; displayNameAr: string; displayNameEn: string } | null;
}

export interface TrustedPerson {
  userId: string;
  displayNameAr: string;
  displayNameEn: string;
  expiresAt: string;
}

export interface DevicesResponse {
  devices: DeviceListItem[];
  /** The open enrollment code, if any (the code itself is shown only once, when created). */
  openCode: { expiresAt: string } | null;
}

/** This PC, as the server knows it (shown at the bottom of the sign-in screen). */
export interface ThisDeviceResponse {
  device: { id: string; code: string; name: string; kind: DeviceKind };
  /** ISO time when the device key must have been renewed (the PC renews it 30 days before). */
  keyExpiresAt: string;
}

export interface EnrollmentCodeResponse {
  /** `XXX-XXX-XXX`, shown once; null when this answer is a repeat of an earlier request. */
  code: string | null;
  expiresAt: string;
}

export const UpdateDeviceRequest = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(DEVICE_KINDS),
    /** The warehouse this PC sells and counts from (null = the default warehouse). */
    defaultWarehouseId: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .nullable(),
  })
  .partial()
  .refine(
    (v) => v.name !== undefined || v.kind !== undefined || v.defaultWarehouseId !== undefined,
    {
      message: 'nothing to change',
    },
  );
export type UpdateDeviceRequest = z.infer<typeof UpdateDeviceRequest>;

/** Revoking a PC is final and always needs a reason (decision 0026). */
/** Settings → Devices: the drawer of a revoked PC moves to the PC enrolled in its place (0069). */
export const MoveDrawerRequest = z.object({
  targetDeviceId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  reason: z.string().trim().min(3).max(500),
});
export type MoveDrawerRequest = z.infer<typeof MoveDrawerRequest>;

export const RevokeDeviceRequest = z.object({ reason: z.string().trim().min(3).max(500) });
export type RevokeDeviceRequest = z.infer<typeof RevokeDeviceRequest>;

/**
 * The idle screen lock per kind of PC (decision 0079): minutes without use before the screen
 * locks, or 0 for never (the session still ends after its maximum length). Owner only.
 */
const LockMinutes = z.number().int().min(0).max(240);
export const ScreenLockSettings = z.object({ officeMinutes: LockMinutes, posMinutes: LockMinutes });
export type ScreenLockSettings = z.infer<typeof ScreenLockSettings>;
