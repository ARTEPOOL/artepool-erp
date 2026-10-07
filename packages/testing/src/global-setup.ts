/** Vitest global setup for integration tests: roles + a migrated template database. */
import pg from 'pg';
import { assertServerVersion, createDatabase, dropDatabase, ensureRoles } from '@artepool/dev-db';
import { migrate } from '@artepool/migrate';
import { connectionFor, migrationsDir } from '@artepool/node-kit';
import { adminClient, templateDatabaseName, testDatabasePrefix } from './database';

async function dropLeftovers(admin: pg.Client): Promise<void> {
  const pattern = new RegExp(`^${testDatabasePrefix()}_[0-9a-f]{8}$`);
  const { rows } = await admin.query<{ datname: string }>('SELECT datname FROM pg_database');
  for (const { datname } of rows.filter((r) => pattern.test(r.datname))) {
    await dropDatabase(admin, datname);
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const template = templateDatabaseName();
  const admin = await adminClient();
  try {
    await assertServerVersion(admin);
    await ensureRoles(admin);
    await dropLeftovers(admin);
    await dropDatabase(admin, template);
    await createDatabase(admin, template);
  } finally {
    await admin.end();
  }

  const migrator = new pg.Client(connectionFor('migrator', template));
  await migrator.connect();
  try {
    await migrate({ client: migrator, dir: migrationsDir });
  } finally {
    await migrator.end();
  }

  return async () => {
    const cleanup = await adminClient();
    try {
      await dropDatabase(cleanup, template);
    } finally {
      await cleanup.end();
    }
  };
}
