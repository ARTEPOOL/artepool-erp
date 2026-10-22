/**
 * The server clock guard (M6.2 part C): when the server clock is behind the latest record, a
 * business write is refused with the CLOCK_BACKWARDS rule (the app shows "correct the Windows
 * time"), and the server's check raises one critical "server clock went back" alert per day.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inContext } from '@artepool/testing';
import { withBusinessTx } from '../../src/platform/db/tx';
import { AppError } from '../../src/platform/errors/app-error';
import { clockStatus, raiseClockAlert } from '../../src/platform/time/clock-guard';
import { startTestServer, type TestServer } from '../support/server';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

const write = () =>
  withBusinessTx(server.db, { userId: 1n, requestId: randomUUID(), reason: 'test' }, (trx) =>
    sql`INSERT INTO sys.alerts (alert_type, severity, dedupe_key)
        VALUES ('low_stock', 'info', ${`clock-${randomUUID()}`})`.execute(trx),
  );

const clockAlerts = async () =>
  (
    await sql<{ severity: string }>`SELECT severity FROM sys.alerts
                                     WHERE alert_type = 'clock_backwards'`.execute(server.db)
  ).rows;

describe('the server clock guard', () => {
  it('does nothing while the clock is right', async () => {
    await write();
    expect((await raiseClockAlert(server.db)).isBehind).toBe(false);
    expect(await clockAlerts()).toEqual([]);
  });

  it('refuses writes with CLOCK_BACKWARDS and raises one critical alert', async () => {
    // A record 10 minutes ahead: as if the Windows clock had just been set back 10 minutes.
    await inContext(server.admin, () =>
      server.admin.query(`INSERT INTO audit.log (user_id, action, entity_type, occurred_at)
                          VALUES (1, 'event:test.clock', 'test', clock_timestamp() + interval '10 minutes')`),
    );
    const refused = await write().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).details).toMatchObject({ rule: 'CLOCK_BACKWARDS' });

    const status = await clockStatus(server.db);
    expect(status.isBehind).toBe(true);
    expect(status.latestRecordAt!.getTime()).toBeGreaterThan(status.serverTime.getTime());
    await raiseClockAlert(server.db);
    await raiseClockAlert(server.db); // checked again 5 minutes later: still one alert
    expect(await clockAlerts()).toEqual([{ severity: 'critical' }]);
  });
});
