import { backupPaths, type BackupPaths } from '@artepool/backup';
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
}

export function createDeps(input: {
  db: Db;
  secretBox: SecretBox;
  hasher?: SecretHasher;
  limits?: RateLimits;
  caCertificatePem?: string | null;
  backup?: BackupPaths;
}): AppDeps {
  return {
    db: input.db,
    caCertificatePem: input.caCertificatePem ?? null,
    secretBox: input.secretBox,
    hasher: input.hasher ?? new SecretHasher(),
    settings: new SettingsCache(input.db),
    limits: input.limits ?? defaultRateLimits(),
    backup: input.backup ?? backupPaths(),
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
