/**
 * The backup service from the command line (development; the installer runs it as a Windows
 * service in M6.2). `once`: one local copy now.
 */
import { loadEnv } from '@artepool/node-kit';
import { configFromEnv } from './config';
import { connect } from './db';
import { localBackup } from './local';

loadEnv();
const command = process.argv[2] ?? 'once';
const config = configFromEnv();
const client = await connect(config.connection);
try {
  if (command === 'once') {
    const copy = await localBackup(client, config);
    console.log(`Local copy written: ${copy.path}`);
  } else {
    console.error(`Unknown command "${command}". Use: once`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
