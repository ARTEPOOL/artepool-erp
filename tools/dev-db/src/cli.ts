/** `pnpm db:setup` — creates the database roles and the development database (development PCs only). */
import pg from 'pg';
import { assertDevOrTestDatabase, connectionFor, loadEnv, requireEnv } from '@artepool/node-kit';
import { assertServerVersion, createDatabase, databaseExists, ensureRoles } from './index';

loadEnv();
const database = requireEnv('ARTEPOOL_DB');
assertDevOrTestDatabase(database);

const admin = new pg.Client(connectionFor('superuser'));
try {
  await admin.connect();
  await assertServerVersion(admin);
  await ensureRoles(admin);
  console.log('Database roles are ready (artepool_owner, _migrator, _api, _backup, _maint).');
  if (await databaseExists(admin, database)) {
    console.log(`Database "${database}" already exists — left unchanged.`);
  } else {
    await createDatabase(admin, database);
    console.log(`Database "${database}" created. Next: pnpm db:migrate`);
  }
} catch (error) {
  console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await admin.end();
}
