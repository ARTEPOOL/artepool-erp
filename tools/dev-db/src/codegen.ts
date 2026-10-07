/**
 * `pnpm db:codegen` regenerates apps/server/src/platform/db/schema.generated.ts from the migrated
 * development database. `pnpm db:codegen:check` fails if the file is out of date (used in CI).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { connectionFor, loadEnv, repoRoot } from '@artepool/node-kit';

loadEnv();
const check = process.argv.includes('--check');
const c = connectionFor('migrator');
const url = `postgres://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${encodeURIComponent(c.database)}`;
const outFile = join(repoRoot, 'apps', 'server', 'src', 'platform', 'db', 'schema.generated.ts');

const args = [
  'exec',
  'kysely-codegen',
  '--dialect',
  'postgres',
  '--url',
  'env(ARTEPOOL_CODEGEN_URL)',
  '--out-file',
  outFile,
  '--exclude-pattern',
  'public.*',
  '--type-mapping',
  JSON.stringify({ int8: 'bigint', date: 'string' }),
  '--date-parser',
  'string',
  '--log-level',
  'error',
  ...(check ? ['--verify'] : []),
];

const result = spawnSync('pnpm', args, {
  cwd: join(repoRoot, 'tools', 'dev-db'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, ARTEPOOL_CODEGEN_URL: url },
});
if (result.status !== 0) {
  console.error(
    check
      ? 'Database types are out of date: run `pnpm db:migrate` then `pnpm db:codegen` and commit the result.'
      : 'Generating database types failed.',
  );
  process.exit(result.status ?? 1);
}
console.log(check ? 'Database types are up to date.' : `Database types written to ${outFile}`);
