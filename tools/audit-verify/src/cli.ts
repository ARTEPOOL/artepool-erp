/** `pnpm audit:verify` — checks the audit chain of the development database. Exit code 2 = tampering. */
import pg from 'pg';
import { connectionFor, loadEnv } from '@artepool/node-kit';
import { describeCheck, verifyAuditChain } from './index';

loadEnv();
const client = new pg.Client({
  ...connectionFor('api'),
  application_name: 'artepool-audit-verify',
});
try {
  await client.connect();
  const check = await verifyAuditChain(client);
  console.log(describeCheck(check));
  process.exitCode = check.ok ? 0 : 2;
} catch (error) {
  console.error(
    `The check could not run: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
