/**
 * The Settings hub (design 13; decision 0034). Each working section is shown to people who hold
 * one of its permissions, checked again by the server on every call; the others arrive in later
 * milestones and are shown greyed.
 */
export type SectionId =
  'company' | 'users' | 'tax' | 'lists' | 'devices' | 'print' | 'backup' | 'audit';

export interface Section {
  id: SectionId;
  /** Any of these opens it; undefined = not built yet ("coming later"). */
  permissions?: readonly string[];
  /** A divider is drawn before it (design 13). */
  dividerBefore?: boolean;
}

export const SECTIONS: Section[] = [
  // Company details are the owner's alone (decision 0030).
  { id: 'company', permissions: ['system.company.edit'] },
  { id: 'users', permissions: ['users.view'] },
  { id: 'tax', permissions: ['system.series.manage', 'ledger.view'] },
  {
    id: 'lists',
    permissions: [
      'items.manage',
      'payment_methods.manage',
      'warehouses.manage',
      'technicians.manage',
      'accounts.manage',
      'system.settings.edit',
    ],
  },
  { id: 'devices', permissions: ['system.devices.manage'] },
  // The owner alone designs print templates (decision 0020).
  { id: 'print', permissions: ['print_templates.manage'] },
  { id: 'backup', dividerBefore: true },
  { id: 'audit', permissions: ['audit.view'] },
];

export const isAllowed = (section: Section, can: (permission: string) => boolean): boolean =>
  section.permissions !== undefined && section.permissions.some(can);

export const allowedSections = (can: (permission: string) => boolean): Section[] =>
  SECTIONS.filter((s) => isAllowed(s, can));

export const canSeeSettings = (can: (permission: string) => boolean): boolean =>
  allowedSections(can).length > 0;
