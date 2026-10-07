import { hash, verify, type Algorithm } from '@node-rs/argon2';

/** Argon2id cost settings. They are stored inside every hash, so they can be raised later. */
export interface Argon2Params {
  /** Memory in KiB. */
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/**
 * Production cost: 64 MiB and 3 passes (RFC 9106, second recommended option). About 0.2 s per
 * check on an office PC, which makes guessing passwords and PINs offline impractically slow.
 */
export const ARGON2_PARAMS: Argon2Params = { memoryCost: 65_536, timeCost: 3, parallelism: 1 };

const ARGON2ID = 2 as Algorithm; // Algorithm.Argon2id (an ambient const enum in the typings)
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

/** The same password typed on different keyboards may arrive composed or decomposed. */
const normalize = (secret: string): string => secret.normalize('NFC');

/**
 * Hashes and checks passwords, PINs and recovery codes with Argon2id. Hashes are PHC strings
 * (`$argon2id$v=19$m=…`), the only format the database accepts.
 */
export class SecretHasher {
  private dummy: Promise<string> | undefined;

  constructor(readonly params: Argon2Params = ARGON2_PARAMS) {}

  hash(secret: string): Promise<string> {
    return hash(normalize(secret), { algorithm: ARGON2ID, ...this.params });
  }

  /** False for a wrong secret or a malformed hash; never throws for those. */
  async verify(hashed: string, secret: string): Promise<boolean> {
    if (!PHC.test(hashed)) return false;
    try {
      return await verify(hashed, normalize(secret));
    } catch {
      return false;
    }
  }

  /**
   * Like verify, but when there is no hash (unknown user, no PIN) it still spends the same
   * effort on a dummy hash and returns false, so response times do not reveal who exists.
   */
  async verifyOrDummy(hashed: string | null | undefined, secret: string): Promise<boolean> {
    if (hashed) return this.verify(hashed, secret);
    this.dummy ??= this.hash('artepool-dummy-secret');
    await this.verify(await this.dummy, secret);
    return false;
  }

  /** True when the hash was made with weaker settings than today's, so it should be redone. */
  needsRehash(hashed: string): boolean {
    const match = PHC.exec(hashed);
    if (!match) return true;
    const [m, t, p] = match.slice(1).map(Number) as [number, number, number];
    return m < this.params.memoryCost || t < this.params.timeCost || p !== this.params.parallelism;
  }
}
