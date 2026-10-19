/**
 * The backup service from the command line (development; the installer runs it as a Windows
 * service in M6.2). `once`: one local copy now; `restore-test`: restore the newest copy into a
 * throwaway database and run every check; `check`: the integrity checks on the live database;
 * `offline <folder>`: copy to the external drive; `run`: the service (the schedule, every minute).
 */
import { loadEnv } from '@artepool/node-kit';
import { configFromEnv } from './config';
import { connect } from './db';
import { nightlyIntegrity } from './integrity';
import { localBackup } from './local';
import { offlineCopy } from './offline';
import { restoreTest } from './restore';
import { tick } from './service';

loadEnv();
const command = process.argv[2] ?? 'once';
const config = configFromEnv();
const client = await connect(config.connection);
try {
  if (command === 'once') {
    const copy = await localBackup(client, config);
    console.log(`Local copy written: ${copy.path}`);
  } else if (command === 'restore-test') {
    const result = await restoreTest(client, config);
    console.log(`${result.ok ? 'OK' : 'PROBLEMS'} — restore test of ${result.fileName}`);
    for (const [name, r] of Object.entries(result.results)) {
      console.log(`  ${r.ok ? '✓' : '✗'} ${name}${r.ok ? '' : `: ${r.examples.join('; ')}`}`);
    }
    if (!result.ok) process.exitCode = 1;
  } else if (command === 'check') {
    const run = await nightlyIntegrity(client);
    console.log(`Integrity checks: ${run.status}`);
    if (run.status !== 'ok') process.exitCode = 1;
  } else if (command === 'offline') {
    const target = process.argv[3];
    if (!target) throw new Error('Give the drive folder, for example: pnpm backup:offline E:\\');
    const copy = await offlineCopy(client, config, { target });
    console.log(`Copied to the drive: ${copy.path}`);
  } else if (command === 'run') {
    console.log(`Backup service started; copies in ${config.backupDir}`);
    for (;;) {
      const done = await tick(client, config);
      if (done.length > 0) console.log(`${new Date().toISOString()} ${done.join(', ')}`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  } else {
    console.error(
      `Unknown command "${command}". Use: once, restore-test, check, offline <folder>, run`,
    );
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
