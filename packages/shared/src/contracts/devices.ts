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
  /** POS PCs only: the kiosk lock kept on the server (decision 0089); null on other PCs. */
  kioskLock: KioskLock | null;
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
/** How labels reach the label printer (decision 0097). */
export const LABEL_PRINT_MODES = ['driver', 'tspl'] as const;
export type LabelPrintMode = (typeof LABEL_PRINT_MODES)[number];

/** The 2-inch label printer's dots per inch, and the ones a label printer may have. */
export const LABEL_DPIS = [203, 300] as const;

/** A number of millimetres with at most one decimal, within limits. */
const mm = (min: number, max: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .refine((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9, 'one decimal at most');

/**
 * The label printer of a PC (decision 0096), kept on the server: the Windows printer's name (null =
 * none chosen yet), its dots per inch, how wide it prints, and the offset found with the test
 * label (positive X = to the right, positive Y = down, in mm).
 */
export const LabelPrinterConfig = z.object({
  printer: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .refine((v) => !v.includes('\0') && !v.includes('/') && !v.includes('..'), 'not a printer name')
    .nullable(),
  dpi: z.union([z.literal(203), z.literal(300)]),
  printableWidthMm: mm(20, 120),
  offsetXMm: mm(-10, 10),
  offsetYMm: mm(-10, 10),
  /** Darkness (TSPL DENSITY 0–15) and speed (TSPL SPEED, inches a second), used in RAW mode (0097). */
  darkness: z.number().int().min(0).max(15).default(8),
  speed: z.number().int().min(1).max(6).default(3),
  /** How labels reach the printer: its Windows driver, or RAW TSPL (decision 0097). */
  mode: z.enum(LABEL_PRINT_MODES).default('driver'),
});
export type LabelPrinterConfig = z.infer<typeof LabelPrinterConfig>;

/** A PC with no label printer set yet: 2-inch printer, 203 dpi, 48 mm, no offset. */
export const DEFAULT_LABEL_PRINTER: LabelPrinterConfig = {
  printer: null,
  dpi: 203,
  printableWidthMm: 48,
  offsetXMm: 0,
  offsetYMm: 0,
  darkness: 8,
  speed: 3,
  mode: 'driver',
};

export interface ThisDeviceResponse {
  device: { id: string; code: string; name: string; kind: DeviceKind };
  /** ISO time when the device key must have been renewed (the PC renews it 30 days before). */
  keyExpiresAt: string;
  /** This PC's label printer (decision 0096); the defaults when none is set yet. */
  labelPrinter: LabelPrinterConfig;
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

/**
 * A POS PC's kiosk lock (decisions 0082, 0089, 0091): on unless the owner turned it off (until a
 * time, null = until turned back on) or the owner is signed in on that PC. Kept on the server,
 * never on the PC.
 */
export interface KioskLock {
  locked: boolean;
  /** The owner turned the switch off (from Settings or with the owner code). */
  switchedOff: boolean;
  /** Until when the switch is off; null = until turned back on (or not switched off). */
  offUntil: string | null;
  /** The owner is signed in on that PC: the lock is off until they sign out or lock the screen. */
  ownerSignedIn: boolean;
}

/** This PC's mode and kiosk lock, read by the app at start and every few seconds. */
export interface KioskStateResponse extends KioskLock {
  isPos: boolean;
}

export const KIOSK_OFF_MINUTES = [15, 60] as const;

/**
 * The owner turns a POS PC's kiosk lock on or off (decision 0089): a reason and the current
 * 2-step code every time; off for 15 minutes, 1 hour, or until turned back on (minutes null).
 */
export const SetKioskLockRequest = z
  .object({
    on: z.boolean(),
    minutes: z.union([z.literal(15), z.literal(60), z.null()]).default(null),
    reason: z.string().trim().min(3).max(500),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict();
export type SetKioskLockRequest = z.infer<typeof SetKioskLockRequest>;

/** On the lock screen: the owner's current code lifts the lock for 5 minutes (decision 0083). */
export const KioskCodeUnlockRequest = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export type KioskCodeUnlockRequest = z.infer<typeof KioskCodeUnlockRequest>;

/** What the POS app reports when someone tries to leave it (decision 0082). */
export const KIOSK_EVENTS = ['close_refused', 'restarted', 'not_running'] as const;
export const KioskEventRequest = z.object({ kind: z.enum(KIOSK_EVENTS) }).strict();
export type KioskEventRequest = z.infer<typeof KioskEventRequest>;

export const KIOSK_ALERT_TYPES = [
  'kiosk_lock_off',
  'kiosk_lock_on',
  'kiosk_exit_attempt',
  'kiosk_code_blocked',
] as const;
export type KioskAlertType = (typeof KIOSK_ALERT_TYPES)[number];

/** A kiosk alert for the owner (Settings → Devices and the owner dashboard, decision 0082). */
export interface KioskAlert {
  id: string;
  alertType: KioskAlertType;
  createdAt: string;
  deviceId: string;
  deviceCode: string;
  deviceName: string;
  /** off: minutes (null = until turned back on) and how; exit attempt: what happened. */
  params: Record<string, unknown>;
}

export interface KioskAlertsResponse {
  alerts: KioskAlert[];
}
