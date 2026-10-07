import type { Db } from '../db/pool';

/**
 * Reads `sys.settings` with a short cache (settings change rarely; every change is audited by the
 * database). `invalidate()` is called after a settings save so the change applies at once.
 */
export class SettingsCache {
  private cached: { at: number; values: ReadonlyMap<string, unknown> } | undefined;

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 5_000,
  ) {}

  async all(): Promise<ReadonlyMap<string, unknown>> {
    if (!this.cached || Date.now() - this.cached.at > this.ttlMs) {
      const rows = await this.db.selectFrom('sys.settings').select(['key', 'value']).execute();
      this.cached = { at: Date.now(), values: new Map(rows.map((r) => [r.key, r.value])) };
    }
    return this.cached.values;
  }

  async number(key: string): Promise<number> {
    const value = (await this.all()).get(key);
    if (typeof value !== 'number') throw new Error(`Setting ${key} is missing or not a number`);
    return value;
  }

  async text(key: string): Promise<string> {
    const value = (await this.all()).get(key);
    if (typeof value !== 'string') throw new Error(`Setting ${key} is missing or not text`);
    return value;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}
