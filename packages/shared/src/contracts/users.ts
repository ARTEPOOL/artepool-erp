/** Settings → Users & permissions (owner only, checked on the server). */
import { z } from 'zod';
import { IdText, type SignInMethod } from './auth';

export const SIGN_IN_METHODS = ['pin', 'password', 'password_totp'] as const;

export type UserStatus = 'active' | 'locked' | 'pin_blocked' | 'inactive';

export interface RoleRef {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
}

export interface UserListItem {
  id: string;
  username: string;
  displayNameAr: string;
  displayNameEn: string;
  signInMethod: SignInMethod;
  roles: RoleRef[];
  status: UserStatus;
  /** Minutes left when status is `locked`. */
  lockedMinutes: number | null;
  lastLoginAt: string | null;
  mustChange: boolean;
  isOwner: boolean;
  deactivatedAt: string | null;
  deactivationReason: string | null;
}

export interface UsersResponse {
  users: UserListItem[];
}

const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/);
const Name = z.string().trim().min(1).max(100);

export const CreateUserRequest = z.object({
  username: Username,
  displayNameAr: Name,
  displayNameEn: Name,
  roleId: IdText,
  signInMethod: z.enum(SIGN_IN_METHODS),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

export const UpdateUserRequest = z
  .object({
    displayNameAr: Name,
    displayNameEn: Name,
    roleId: IdText,
    language: z.enum(['ar', 'en']),
  })
  .partial();
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

/** Optionally switches the sign-in method at the same time (a new temporary code is issued). */
export const ResetCredentialsRequest = z.object({
  signInMethod: z.enum(SIGN_IN_METHODS).optional(),
});
export type ResetCredentialsRequest = z.infer<typeof ResetCredentialsRequest>;

/** Deactivating always needs a reason (decision 0026). */
export const DeactivateUserRequest = z.object({ reason: z.string().trim().min(3).max(500) });
export type DeactivateUserRequest = z.infer<typeof DeactivateUserRequest>;

/** A temporary password or PIN, shown once to the owner to hand over in person. */
export interface TemporaryCodeResponse {
  user: UserListItem;
  /** Null when this answer is a repeat of an earlier request (the code is never shown twice). */
  temporaryCode: string | null;
  kind: 'password' | 'pin';
}

export interface PermissionInfo {
  code: string;
  module: string;
  nameAr: string;
  nameEn: string;
  isSensitive: boolean;
  approvable: boolean;
  ownerOnly: boolean;
}

export interface RoleInfo extends RoleRef {
  isSystem: boolean;
  isActive: boolean;
  requires2fa: boolean;
  /** Discount limit without approval, in basis points (100 = 1%). */
  maxDiscountBp: number;
  /** Discount limit without approval, in fils (text: exact integer). */
  maxDiscountFils: string;
  permissions: string[];
  activeUsers: number;
}

export interface RolesResponse {
  roles: RoleInfo[];
  permissions: PermissionInfo[];
}

export const CreateRoleRequest = z.object({
  nameAr: Name,
  nameEn: Name,
  copyFromRoleId: IdText,
});
export type CreateRoleRequest = z.infer<typeof CreateRoleRequest>;

const Fils = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);

export const UpdateRoleRequest = z
  .object({
    nameAr: Name,
    nameEn: Name,
    permissions: z.array(z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/)).max(500),
    maxDiscountBp: z.number().int().min(0).max(10_000),
    maxDiscountFils: Fils,
    isActive: z.boolean(),
  })
  .partial();
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequest>;

// Supervisor approvals (architecture §5.5) ------------------------------------------------------

export const ApprovalRequest = z.object({
  permission: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/),
  approverId: IdText,
  /** The current 6-digit code from the approver's 2-step app (decision 0074). */
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
  reason: z.string().trim().min(3).max(500),
  context: z.record(z.string(), z.unknown()).default({}),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export interface ApprovalResponse {
  approvalId: string;
  expiresAt: string;
}

export interface Approver {
  id: string;
  displayNameAr: string;
  displayNameEn: string;
}
