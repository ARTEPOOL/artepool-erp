/**
 * `pnpm demo:audit-tamper` — shows the audit chain catching a secret change.
 * Works on a throwaway database (…_test_demo) that is deleted at the end; your data is never touched.
 */
import pg from 'pg';
import { createDatabase, dropDatabase } from '@artepool/dev-db';
import { migrate } from '@artepool/migrate';
import { connectionFor, loadEnv, migrationsDir, requireEnv } from '@artepool/node-kit';
import { describeCheck, verifyAuditChain } from './index';

loadEnv();
const demoDb = `${requireEnv('ARTEPOOL_TEST_DB')}_demo`;
const say = (text: string) => console.log(`\n${text}`);

const admin = new pg.Client(connectionFor('superuser'));
await admin.connect();
try {
  say(`1. Creating a throwaway demo database "${demoDb}" …`);
  await dropDatabase(admin, demoDb);
  await createDatabase(admin, demoDb);
  const migrator = new pg.Client(connectionFor('migrator', demoDb));
  await migrator.connect();
  await migrate({ client: migrator, dir: migrationsDir });
  await migrator.end();

  say('2. Doing some normal work through the system: adding a branch and a cashier …');
  const api = new pg.Client(connectionFor('api', demoDb));
  await api.connect();
  await api.query('BEGIN');
  await api.query(`SELECT sys.set_context(1, p_reason => 'demo: normal work')`);
  await api.query(
    `INSERT INTO sys.branches (code, name_ar, name_en) VALUES ('DEMO', 'فرع تجريبي', 'Demo branch')`,
  );
  await api.query(`INSERT INTO auth.users (username, display_name_ar, display_name_en, password_hash)
                   VALUES ('demo.cashier', 'أمين صندوق', 'Demo cashier', 'not-a-real-hash')`);
  await api.query('COMMIT');

  say('3. Checking the audit chain:');
  console.log(describeCheck(await verifyAuditChain(api)));

  const { rows } = await api.query<{ seq: string }>(
    `SELECT chain_seq::text AS seq FROM audit.log WHERE entity_type = 'sys.branches' AND new_values->>'code' = 'DEMO'`,
  );
  const seq = rows[0]!.seq;
  say(
    `4. Now someone with FULL database access switches off the protection and secretly edits entry #${seq}\n` +
      `   (the record of the new branch), as if it had always been called "Secret branch" …`,
  );
  const attacker = new pg.Client(connectionFor('superuser', demoDb));
  await attacker.connect();
  await attacker.query(`
    ALTER TABLE audit.log DISABLE TRIGGER guard_log;
    UPDATE audit.log SET new_values = jsonb_set(new_values, '{name_en}', '"Secret branch"') WHERE chain_seq = ${seq};
    ALTER TABLE audit.log ENABLE TRIGGER guard_log;`);
  await attacker.end();

  say('5. Checking the audit chain again:');
  const check = await verifyAuditChain(api);
  console.log(describeCheck(check));
  await api.end();

  say(
    check.ok
      ? 'UNEXPECTED: the change was not detected. Please report this.'
      : `Result: the secret change was caught at entry #${check.firstBadEntry}. The demo database is now deleted.`,
  );
  if (check.ok) process.exitCode = 1;
} finally {
  await dropDatabase(admin, demoDb).catch(() => undefined);
  await admin.end();
}
