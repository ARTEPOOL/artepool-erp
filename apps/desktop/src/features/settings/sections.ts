/**
 * The Settings hub (design 13). Each working section needs a permission, checked again by the
 * server on every call; the others arrive in later milestones and are shown greyed.
 */
export type SectionId = 'company' | 'users' | 'tax' | 'devices' | 'print' | 'backup' | 'audit';

export interface Section {
  id: SectionId;
  /** Needed to open it; undefined = not built yet ("coming later"). */
  permission?: string;
  /** A divider is drawn before it (design 13). */
  dividerBefore?: boolean;
}

export const SECTIONS: Section[] = [
  { id: 'company' },
  { id: 'users', permission: 'users.view' },
  { id: 'tax' },
  { id: 'devices', permission: 'system.devices.manage' },
  { id: 'print' },
  { id: 'backup', dividerBefore: true },
  { id: 'audit', permission: 'audit.view' },
];

export const allowedSections = (can: (permission: string) => boolean): Section[] =>
  SECTIONS.filter((s) => s.permission !== undefined && can(s.permission));

export const canSeeSettings = (can: (permission: string) => boolean): boolean =>
  allowedSections(can).length > 0;
