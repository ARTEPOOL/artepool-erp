import { join } from 'node:path';
import { backupPaths, type BackupPaths } from '@artepool/backup';
import { repoRoot } from '@artepool/node-kit';
import { LATEST_URL } from '@artepool/release';
import { updaterWaker, type WakeUpdater } from '../../modules/updates/wake';
import { SecretHasher } from '../crypto/hashing';
import type { SecretBox } from '../crypto/secret-box';
import type { Db } from '../db/pool';
import { SettingsCache } from '../settings';
import { defaultRateLimits, type RateLimits } from './rate-limit';

/** Everything the routes need, created once at start-up and shared. */
export interface AppDeps {
  readonly db: Db;
  readonly hasher: SecretHasher;
  readonly secretBox: SecretBox;
  readonly settings: SettingsCache;
  readonly limits: RateLimits;
  /**
   * The ARTÉPOOL CA certificate (PEM) that enrolling PCs learn to trust (decision 0024).
   * Null until the secure connection is set up (`pnpm tls:init`): enrollment is then refused.
   */
  readonly caCertificatePem: string | null;
  /** The backup folder and the sealed Google Drive credentials (decision 0086). */
  readonly backup: BackupPaths;
  /**
   * The installer's one-time setup token (decision 0102): `ProgramData\ARTEPOOL\setup\token` on
   * the installed server, readable by administrators only and deleted when setup completes.
   */
  readonly setupTokenFile: string;
  /**
   * Where System health looks on the server PC (M6.2 part H): the data folder (its disk holds the
   * database) and the TLS folder (the server certificate and the root CA).
   */
  readonly health: { dataDir: string; tlsDir: string };
  /**
   * Decision 0115: the public update list, read by the server for the owner's "Check now", and
   * waking the server PC's updater after "Check now" and "Install now".
   */
  readonly updates: { fetchLatest: () => Promise<unknown>; wake: WakeUpdater };
}

/** The update list for "Check now": 15 seconds at most, then the updater tries by itself. */
async function fetchUpdateList(): Promise<unknown> {
  const response = await fetch(LATEST_URL, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`The update list answered HTTP ${response.status}`);
  return response.json();
}

export function createDeps(input: {
  db: Db;
  secretBox: SecretBox;
  hasher?: SecretHasher;
  limits?: RateLimits;
  caCertificatePem?: string | null;
  backup?: BackupPaths;
  setupTokenFile?: string;
  health?: { dataDir: string; tlsDir: string };
  updates?: Partial<AppDeps['updates']>;
}): AppDeps {
  return {
    db: input.db,
    caCertificatePem: input.caCertificatePem ?? null,
    secretBox: input.secretBox,
    hasher: input.hasher ?? new SecretHasher(),
    settings: new SettingsCache(input.db),
    limits: input.limits ?? defaultRateLimits(),
    backup: input.backup ?? backupPaths(),
    setupTokenFile:
      input.setupTokenFile ??
      (process.env.ARTEPOOL_SETUP_TOKEN_FILE || join(repoRoot, '.secrets', 'setup', 'token')),
    health: input.health ?? {
      dataDir: process.env.ARTEPOOL_DATA_DIR || repoRoot,
      tlsDir: process.env.ARTEPOOL_TLS_DIR || join(repoRoot, '.secrets', 'tls'),
    },
    updates: {
      fetchLatest: input.updates?.fetchLatest ?? fetchUpdateList,
      wake: input.updates?.wake ?? updaterWaker(),
    },
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
