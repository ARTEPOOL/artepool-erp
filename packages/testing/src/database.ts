import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { createDatabase, dropDatabase } from '@artepool/dev-db';
import { connectionFor, loadEnv, requireEnv, type LoginRole } from '@artepool/node-kit';

loadEnv();

export function testDatabasePrefix(): string {
  return requireEnv('ARTEPOOL_TEST_DB');
}

/** The migrated database that every test database is copied from (built once per test run). */
export function templateDatabaseName(): string {
  return `${testDatabasePrefix()}_template`;
}

export async function adminClient(database?: string): Promise<pg.Client> {
  const client = new pg.Client({
    ...connectionFor('superuser', database),
    application_name: 'artepool-test-admin',
  });
  await client.connect();
  return client;
}

/** A throwaway database for one test file. Every client opened through it is closed by drop(). */
export class TestDatabase {
  private readonly clients: pg.Client[] = [];

  constructor(readonly name: string) {}

  async connect(role: LoginRole = 'api'): Promise<pg.Client> {
    const client = new pg.Client({
      ...connectionFor(role, this.name),
      application_name: `artepool-test-${role}`,
    });
    await client.connect();
    // A connection the database closes while idle (a test that renames or replaces this database,
    // as the restore from a backup does) must not stop the test run; queries still fail loudly.
    client.on('error', () => undefined);
    this.clients.push(client);
    return client;
  }

  async drop(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.end().catch(() => undefined)));
    const admin = await adminClient();
    try {
      await dropDatabase(admin, this.name);
    } finally {
      await admin.end();
    }
  }
}

function uniqueName(): string {
  return `${testDatabasePrefix()}_${randomBytes(4).toString('hex')}`;
}

async function create(template?: string): Promise<TestDatabase> {
  const name = uniqueName();
  const admin = await adminClient();
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await createDatabase(admin, name, template);
        break;
      } catch (error) {
        // 55006: the template is briefly busy because another test file is copying it.
        if ((error as { code?: string }).code !== '55006' || attempt >= 10) throw error;
        await sleep(100 * attempt);
      }
    }
  } finally {
    await admin.end();
  }
  return new TestDatabase(name);
}

/** A fresh database with every migration applied (a copy of the template). */
export function createTestDatabase(): Promise<TestDatabase> {
  return create(templateDatabaseName());
}

/** A fresh, completely empty database (no migrations). */
export function createEmptyTestDatabase(): Promise<TestDatabase> {
  return create();
}
