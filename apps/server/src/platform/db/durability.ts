/**
 * What keeps a confirmed sale on the disk through a power cut (M6.2 part I): PostgreSQL writes and
 * flushes the WAL before it says "committed" (fsync, synchronous_commit), writes whole pages after
 * a checkpoint so a half-written page can be repaired (full_page_writes), and on Windows flushes
 * through the disk's own write cache (wal_sync_method = fsync_writethrough). Data checksums (set
 * by initdb, decision 0086) find a damaged page instead of reading it.
 *
 * The server setup writes these into postgresql.conf; an upgrade or a reinstall sets any that are
 * missing with ALTER SYSTEM; System health shows them and alerts the owner if one is off.
 */
import type pg from 'pg';
import { sql, type Kysely } from 'kysely';

export interface DurabilitySettings {
  fsync: string;
  synchronous_commit: string;
  full_page_writes: string;
  wal_sync_method: string;
  data_checksums: string;
}

const NAMES: (keyof DurabilitySettings)[] = [
  'fsync',
  'synchronous_commit',
  'full_page_writes',
  'wal_sync_method',
  'data_checksums',
];

/** The values this server must run with (wal_sync_method only on Windows). */
export function requiredDurability(windows: boolean): Partial<DurabilitySettings> {
  return {
    fsync: 'on',
    synchronous_commit: 'on',
    full_page_writes: 'on',
    ...(windows ? { wal_sync_method: 'fsync_writethrough' } : {}),
  };
}

/** The settings that differ from what is required (data checksums cannot be changed here). */
export function durabilityChanges(
  current: DurabilitySettings,
  windows: boolean,
): Partial<DurabilitySettings> {
  const changes: Partial<DurabilitySettings> = {};
  for (const [name, value] of Object.entries(requiredDurability(windows)) as [
    keyof DurabilitySettings,
    string,
  ][]) {
    if (current[name] !== value) changes[name] = value;
  }
  return changes;
}

/** Each setting that is wrong, data checksums included. */
export function durabilityProblems(current: DurabilitySettings, windows: boolean): string[] {
  const wrong = Object.keys(durabilityChanges(current, windows));
  if (current.data_checksums !== 'on') wrong.push('data_checksums');
  return wrong;
}

const SELECT = `SELECT name, setting FROM pg_settings WHERE name = ANY ($1)`;

function settingsFrom(rows: { name: string; setting: string }[]): DurabilitySettings {
  const map = Object.fromEntries(rows.map((r) => [r.name, r.setting]));
  return Object.fromEntries(NAMES.map((n) => [n, map[n] ?? ''])) as unknown as DurabilitySettings;
}

/** The running values, through the API's database (pg_settings is readable by everyone). */
export async function readDurability<DB>(db: Kysely<DB>): Promise<DurabilitySettings> {
  const { rows } = await sql<{ name: string; setting: string }>`
    SELECT name, setting FROM pg_settings WHERE name = ANY (${NAMES})`.execute(db);
  return settingsFrom(rows);
}

/**
 * As the superuser (upgrade, reinstall): sets the missing values with ALTER SYSTEM and reloads.
 * All of them take effect on reload, without a restart. Returns what was changed.
 */
export async function ensureDurability(
  superuser: pg.Client,
  windows: boolean,
): Promise<Partial<DurabilitySettings>> {
  const { rows } = await superuser.query<{ name: string; setting: string }>(SELECT, [NAMES]);
  const changes = durabilityChanges(settingsFrom(rows), windows);
  for (const [name, value] of Object.entries(changes)) {
    // Names come from the list above; values are fixed words, never user input.
    await superuser.query(`ALTER SYSTEM SET ${name} = '${value}'`);
  }
  if (Object.keys(changes).length > 0) await superuser.query('SELECT pg_reload_conf()');
  return changes;
}
