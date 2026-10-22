/**
 * The first-run wizard on the server PC (decisions 0092, 0102; M6.2 part D). Every request carries
 * the installer's one-time setup token in this header, comes from the server PC itself
 * (127.0.0.1), and is refused once setup is complete.
 */
import { z } from 'zod';
import type { CompanyProfile } from './company';

export const SETUP_TOKEN_HEADER = 'x-artepool-setup';

/** The token the installer writes: 32 random bytes, base64url. */
export const SetupToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const SETUP_STATES = ['not_started', 'in_progress', 'complete'] as const;
export type SetupState = (typeof SETUP_STATES)[number];

export interface SetupStatusResponse {
  state: SetupState;
  path: 'new' | 'restore' | null;
  /** Saved company details (with their version), or null. */
  company: CompanyProfile | null;
  owner: {
    username: string;
    displayNameAr: string;
    displayNameEn: string;
    twoStepEnabled: boolean;
  } | null;
  /** The POS device enrolled during setup, if any. */
  posDevice: { code: string; name: string } | null;
}

export const SetupStartRequest = z.object({ path: z.literal('new') });
export type SetupStartRequest = z.infer<typeof SetupStartRequest>;

export const SetupOwnerRequest = z.object({
  username: z.string().trim().toLowerCase().max(64),
  displayNameAr: z.string().trim().max(100),
  displayNameEn: z.string().trim().max(100),
  password: z.string().max(256),
});
export type SetupOwnerRequest = z.infer<typeof SetupOwnerRequest>;

export const SetupTwoStepConfirmRequest = z.object({ code: z.string().regex(/^\d{6}$/) });
export type SetupTwoStepConfirmRequest = z.infer<typeof SetupTwoStepConfirmRequest>;

export interface SetupTwoStepConfirmResponse {
  /** Shown once: 10 one-time recovery codes to print and keep (decision 0022). */
  recoveryCodes: string[];
}

export interface SetupDeviceCodeResponse {
  /** A one-time enrollment code for this PC; the app enrolls it as the POS at once. */
  code: string;
  expiresAt: string;
}
