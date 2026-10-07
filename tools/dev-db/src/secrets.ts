/**
 * `pnpm dev:secrets` — creates the development master key (`.secrets/master.key`) that encrypts
 * the owner's 2-step secret. Development PCs only: production keys are protected by Windows
 * DPAPI through the installer (M6). An existing key is never replaced, because secrets sealed
 * with it could no longer be opened.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadEnv, repoRoot } from '@artepool/node-kit';

loadEnv();
const file = process.env.ARTEPOOL_MASTER_KEY_FILE || join(repoRoot, '.secrets', 'master.key');

if (existsSync(file)) {
  console.log(`Master key already exists — left unchanged: ${file}`);
} else {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  console.log(`Master key created: ${file}`);
  console.log('Keep it private. It is ignored by Git and must never be shared or committed.');
}
