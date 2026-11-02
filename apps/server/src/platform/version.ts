/**
 * The server's own version (decision 0115): the installed manifest's (`server\manifest.json`,
 * written by `pnpm build:server`), or in development the app's package version. Every PC's app
 * compares it, once the server answers again after an update, with the version the status page
 * announced, to say whether the update worked.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '@artepool/node-kit';

let known: string | null = null;

export function serverVersion(): string {
  if (known) return known;
  const resources = process.env.ARTEPOOL_RESOURCES;
  const file = resources
    ? join(resources, '..', 'manifest.json')
    : join(repoRoot, 'apps', 'desktop', 'package.json');
  try {
    const { version } = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
    known = typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : '0.0.0';
  } catch {
    known = '0.0.0';
  }
  return known;
}
