/**
 * The backup service from the command line (development; the installer runs it as a Windows
 * service in M6.2). `once`: one local copy now; `restore-test`: restore the newest copy into a
 * throwaway database and run every check; `check`: the integrity checks on the live database;
 * `offline <folder>`: copy to the external drive; `run`: the service (the schedule, every minute);
 * `open <copy> <key file> <output.dump>`: an encrypted off-site copy opened with the owner's
 * private key, its database copy written out (emergency manual restore; the wizard is the normal
 * way, decision 0102).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { loadEnv } from '@artepool/node-kit';
import { openCopy } from './bundle';
import { configFromEnv } from './config';
import { connect } from './db';
import { nightlyIntegrity } from './integrity';
import { localBackup } from './local';
import { offlineCopy } from './offline';
import { restoreTest } from './restore';
import { startHeartbeat } from './heartbeat';
import { tick } from './service';

loadEnv();
const command = process.argv[2] ?? 'once';
if (command === 'open') {
  const [copyFile, keyFile, output] = process.argv.slice(3);
  if (!copyFile || !keyFile || !output) {
    console.error('Use: open <copy.dump.age> <private key file> <output.dump>');
    process.exit(2);
  }
  try {
    const opened = await openCopy(await readFile(copyFile), await readFile(keyFile, 'utf8'));
    await writeFile(output, opened.dump, { flag: 'wx' });
    console.log(`Database copy written: ${output}`);
    console.log(
      opened.masterKey
        ? "The copy also holds the server's master key; only the setup wizard's restore puts it back."
        : 'This copy holds no master key: after restoring it, set up the 2-step codes again.',
    );
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
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
    // System health reads this sign of life (M6.2 part H).
    startHeartbeat(config.backupDir, (error) =>
      console.error(
        `Could not write the heartbeat: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
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
