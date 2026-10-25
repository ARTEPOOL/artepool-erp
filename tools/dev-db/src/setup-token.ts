/**
 * `pnpm dev:setup-token` — development only: the one-time setup token the installer writes on the
 * server PC (decision 0102), so the first-run wizard can be tried in a browser
 * (`pnpm dev:server` + `pnpm dev:desktop:web`) on a database without an owner. The wizard deletes
 * the token when it completes.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadEnv, repoRoot } from '@artepool/node-kit';

loadEnv();
const file = process.env.ARTEPOOL_SETUP_TOKEN_FILE || join(repoRoot, '.secrets', 'setup', 'token');
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Setup token written: ${file}`);
console.log('Open the app: the first-run wizard shows while the database has no completed setup.');
