/**
 * `pnpm build:server [--out <folder>] [--windows]`: the server PC's programs as one folder
 * (default `dist/server`). `--windows` refuses to finish without the Windows Argon2 library.
 */
import { join, resolve } from 'node:path';
import { repoRoot } from '@artepool/node-kit';
import { buildServer } from './build';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? resolve(args[outIndex + 1] ?? '') : join(repoRoot, 'dist', 'server');

try {
  await buildServer({
    outDir,
    platform: args.includes('--windows') ? 'win32' : process.platform,
    log: (message) => console.log(message),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
