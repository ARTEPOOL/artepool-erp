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
}

export function createDeps(input: {
  db: Db;
  secretBox: SecretBox;
  hasher?: SecretHasher;
  limits?: RateLimits;
}): AppDeps {
  return {
    db: input.db,
    secretBox: input.secretBox,
    hasher: input.hasher ?? new SecretHasher(),
    settings: new SettingsCache(input.db),
    limits: input.limits ?? defaultRateLimits(),
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
