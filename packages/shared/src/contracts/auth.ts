/**
 * Sign-in API contracts, shared by the server (validation) and the desktop app (typed calls).
 * Limits are generous on purpose: a value that is too long or malformed is simply a wrong
 * credential, so the answer never reveals which part was wrong.
 */
import { z } from 'zod';

/** Database ids travel as decimal text (they are bigint). */
/**
 * A trust this long means "until the password changes" (decision 0077): the PC is remembered after
 * the phone code there and forgets it when the password, the 2-step setup, the user or the PC changes.
 */
export const TRUST_UNTIL_PASSWORD_CHANGE_DAYS = 3650;

export const IdText = z.string().regex(/^[1-9][0-9]{0,18}$/);

export const SignInRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type SignInRequest = z.infer<typeof SignInRequest>;

export const PinSignInRequest = z.object({ userId: IdText, pin: z.string().min(1).max(16) });
export type PinSignInRequest = z.infer<typeof PinSignInRequest>;

/**
 * The 6-digit code (optionally trusting this PC, decision 0027), or one recovery code. A recovery
 * code never trusts the PC: the 2-step code must be set up again first.
 */
export const SecondFactorRequest = z.union([
  z.object({ code: z.string().min(1).max(16), trustDevice: z.boolean().optional() }).strict(),
  z.object({ recoveryCode: z.string().min(1).max(32) }).strict(),
]);
export type SecondFactorRequest = z.infer<typeof SecondFactorRequest>;

/** Forgot password (decision 0028): the phone code and one recovery code prove who it is. */
export const RecoverPasswordRequest = z.object({
  username: z.string().min(1).max(64),
  code: z.string().min(1).max(16),
  recoveryCode: z.string().min(1).max(32),
  newPassword: z.string().min(1).max(256),
});
export type RecoverPasswordRequest = z.infer<typeof RecoverPasswordRequest>;

export const TwoStepConfirmRequest = z.object({ code: z.string().min(1).max(16) });
export type TwoStepConfirmRequest = z.infer<typeof TwoStepConfirmRequest>;

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/** `current` is the current PIN for PIN users, or the password for password users. */
export const ChangePinRequest = z.object({
  current: z.string().min(1).max(256),
  newPin: z.string().min(1).max(16),
});
export type ChangePinRequest = z.infer<typeof ChangePinRequest>;

/** The signed-in user's own password or PIN, to unlock a locked screen. */
export const UnlockRequest = z.object({ secret: z.string().min(1).max(256) });
export type UnlockRequest = z.infer<typeof UnlockRequest>;

export type SignInMethod = 'pin' | 'password' | 'password_totp';
/** `trusted_device`: the password alone, on a PC the person trusted (decision 0027). */
export type AuthMethod = 'password' | 'password_totp' | 'recovery_code' | 'pin' | 'trusted_device';
export type SessionStage = 'second_factor' | 'full';
export type PendingStep = 'credential_change' | 'two_step_setup' | null;

export interface SessionView {
  stage: SessionStage;
  authMethod: AuthMethod;
  pending: PendingStep;
  locked: boolean;
  /** ISO time (UTC) when the session ends at the latest. */
  expiresAt: string;
  idleTimeoutSeconds: number;
}

export interface UserView {
  id: string;
  username: string;
  displayNameAr: string;
  displayNameEn: string;
  language: 'ar' | 'en';
  signInMethod: SignInMethod;
}

export interface DeviceView {
  id: string;
  code: string;
  name: string;
  kind: 'pos' | 'office' | 'warehouse' | 'server';
}

export interface SignInResponse {
  /** Opaque session token: kept in memory only, sent as `Authorization: Bearer …`. */
  token: string;
  session: SessionView;
  user: UserView;
  /**
   * Only while the 2-step code is awaited, and only where "Trust this PC" is offered (not on POS
   * PCs, not when turned off): how many days the trust would last (decision 0027).
   */
  trustDays?: number;
  /**
   * When the password was reset on the server PC (decision 0029) and the person has not chosen
   * their own since: when, and the reason typed there. Shown on "Choose your own password".
   */
  serverReset?: { at: string; reason: string };
}

export interface RecoverPasswordResponse extends SignInResponse {
  /** Recovery codes still unused after this one (decision 0028). */
  recoveryCodesLeft: number;
}

export interface MeResponse {
  session: SessionView;
  user: UserView;
  device: DeviceView;
  permissions: string[];
}

export interface PinUser {
  id: string;
  displayNameAr: string;
  displayNameEn: string;
  blocked: boolean;
}

export interface PinUsersResponse {
  /** PIN sign-in works only on PCs enrolled as POS (decision 0021). */
  pinAllowed: boolean;
  users: PinUser[];
}

export interface TwoStepStartResponse {
  /** Base32 secret, for typing into the app if the QR code cannot be scanned. */
  secret: string;
  /** `otpauth://` link shown as a QR code. */
  uri: string;
}

export interface TwoStepConfirmResponse extends SignInResponse {
  /** Shown once: 10 one-time recovery codes to print and keep in the safe (decision 0022). */
  recoveryCodes: string[];
}
