/**
 * The key M1 test: every API route declares who may use it, and every permission-protected route
 * refuses, on the server, a signed-in user who lacks that permission.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDevice,
  addUser,
  call,
  errorCode,
  openSession,
  startTestServer,
  type TestServer,
} from '../support/server';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

describe('every route', () => {
  it('declares its access, and the only public ones are health and enrollment', () => {
    const table = server.app.accessTable;
    expect(table.length).toBeGreaterThan(25);
    expect(
      table
        .filter((r) => r.access.kind === 'public')
        .map((r) => r.url)
        .sort(),
    ).toEqual(['/api/v1/enroll/complete', '/api/v1/enroll/hello', '/health']);
  });

  it('refuses a user who lacks the route permission, before doing anything', async () => {
    const device = await addDevice(server, { code: 'TECH-PC' });
    // The technician holds only items.view and customers.view.
    const userId = await addUser(server, { username: 'tech.one', roles: ['technician'] });
    const { token } = await openSession(server, { userId, deviceId: device.id });
    const held = new Set(['items.view', 'customers.view']);
    const checked: string[] = [];
    for (const route of server.app.accessTable) {
      if (route.access.kind !== 'permission' || held.has(route.access.permission)) continue;
      const url = route.url.replace(/:[a-z]+/g, '1');
      const response = await call(server, route.method as 'GET' | 'POST' | 'PATCH', url, {
        device,
        token,
        idempotencyKey: randomUUID(),
        body: route.method === 'GET' ? undefined : {},
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(errorCode(response), `${route.method} ${route.url}`).toBe('PERMISSION_DENIED');
      checked.push(`${route.method} ${route.url}`);
    }
    expect(checked.length).toBeGreaterThan(15);
    const refusals = await server.db
      .selectFrom('audit.log')
      .select('id')
      .where('action', '=', 'event:auth.permission_denied')
      .where('user_id', '=', userId)
      .execute();
    expect(refusals).toHaveLength(checked.length);
  });
});
