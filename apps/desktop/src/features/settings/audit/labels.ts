/** Turns raw audit entries into words people read (Settings → Audit log). */
import type { TFunction, i18n as I18n } from 'i18next';
import type { AuditEntry } from '@artepool/shared/contracts';
import { formatDateTime } from '../../../lib/format';

export type Tone = 'neutral' | 'warn' | 'danger';

const DANGER = /failed|locked|blocked|denied|refused/;
const WARN = /reset|recovery_code_used|password_recovered|exported/;

/** "Signed in", "User changed", "Role created"…; unknown ones fall back to a generic text. */
export function actionLabel(entry: AuditEntry, t: TFunction, i18n: I18n): string {
  if (entry.action.startsWith('event:')) {
    const name = entry.action.slice('event:'.length);
    const key = `settings:audit.events.${name}`;
    return i18n.exists(key) ? t(key) : t('settings:audit.events.other', { name });
  }
  const table = entry.entityType ?? '';
  const key = `settings:audit.tables.${table}.${entry.action}`;
  if (i18n.exists(key)) return t(key);
  const generic = `settings:audit.generic.${entry.action}`;
  return i18n.exists(generic) ? t(generic, { table }) : `${entry.action} · ${table}`;
}

export function actionTone(entry: AuditEntry): Tone {
  if (DANGER.test(entry.action)) return 'danger';
  if (WARN.test(entry.action)) return 'warn';
  return 'neutral';
}

/** What kind of record it is about, for the icon. */
export function actionArea(
  entry: AuditEntry,
): 'sign-in' | 'user' | 'role' | 'device' | 'audit' | 'settings' | 'data' {
  const a = entry.action;
  const table = entry.entityType ?? '';
  if (a.startsWith('event:audit.') || table.startsWith('audit.')) return 'audit';
  if (/sign_in|signed_in|session|pin_|password|two_step|recovery|account_locked/.test(a)) {
    return 'sign-in';
  }
  if (
    table === 'auth.devices' ||
    table === 'auth.device_trust' ||
    table === 'auth.enrollment_codes' ||
    /device|enrollment/.test(a)
  ) {
    return 'device';
  }
  if (table === 'auth.roles' || table === 'auth.role_permissions' || table === 'auth.permissions') {
    return 'role';
  }
  if (table.startsWith('auth.')) return 'user';
  if (table.startsWith('sys.')) return 'settings';
  return 'data';
}

export function fieldLabel(field: string, t: TFunction, i18n: I18n): string {
  const key = `settings:audit.fields.${field}`;
  return i18n.exists(key) ? t(key) : field;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A recorded value as text: times in Al Ain time, yes/no for true/false, — for empty. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (value === true) return '✓';
  if (value === false) return '✗';
  if (typeof value === 'string') return ISO_TIME.test(value) ? formatDateTime(value) : value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

/** Fields that changed (update), or were set (insert); bookkeeping columns left out. */
export function changedFields(
  entry: AuditEntry,
): { field: string; before: unknown; after: unknown }[] {
  const skip = new Set([
    'id',
    'created_at',
    'created_by',
    'updated_at',
    'updated_by',
    'row_version',
  ]);
  const before = entry.oldValues ?? {};
  const after = entry.newValues ?? {};
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (f) => !skip.has(f),
  );
  return fields
    .map((field) => ({ field, before: before[field], after: after[field] }))
    .filter((row) => JSON.stringify(row.before) !== JSON.stringify(row.after));
}
