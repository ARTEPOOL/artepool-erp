/**
 * Database upgrade tool.
 *   pnpm db:migrate            apply pending migrations
 *   pnpm db:migrate --dry-run  check pending migrations, then undo everything
 *   pnpm db:status             show applied / pending migrations and verify checksums
 *   pnpm db:new <name>         create the next migration file
 */
import pg from 'pg';
import { connectionFor, loadEnv, migrationsDir } from '@artepool/node-kit';
import { MigrationError } from './errors';
import { createMigrationFile, migrate, migrationStatus } from './runner';

loadEnv();
const [command = 'up', ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  if (command === 'new') {
    const name = rest[0];
    if (!name) throw new MigrationError('BAD_FILE_NAME', 'Usage: pnpm db:new <lower_snake_name>');
    console.log(`Created ${createMigrationFile(migrationsDir, name)}`);
    return;
  }

  const client = new pg.Client({
    ...connectionFor('migrator'),
    application_name: 'artepool-migrate',
  });
  await client.connect();
  try {
    if (command === 'status') {
      const { applied, pending } = await migrationStatus(client, migrationsDir);
      console.log(`Applied: ${applied.length} (all unchanged). Pending: ${pending.length}.`);
      for (const file of pending) console.log(`  pending ${file.fileName}`);
    } else if (command === 'up') {
      const dryRun = rest.includes('--dry-run');
      const done = await migrate({
        client,
        dir: migrationsDir,
        dryRun,
        log: (m) => console.log(m),
      });
      if (dryRun) {
        console.log(
          `Dry run OK: ${done.length} pending migration(s) apply cleanly. Nothing was changed.`,
        );
      } else {
        console.log(
          done.length === 0
            ? 'Database is already up to date.'
            : `Database upgraded: ${done.length} migration(s) applied.`,
        );
      }
    } else {
      throw new MigrationError('FAILED', `Unknown command "${command}". Use up, status or new.`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(`Migration stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
