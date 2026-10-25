/**
 * The programs the server installer ships (M6.2 part F): Node 24 (`node.exe`), PostgreSQL 18 and
 * WinSW, pinned in `components.json` by version and SHA-256. A download is used only when its
 * hash matches; anything else stops the build (decision 0007: what goes on the shop PC is known
 * byte for byte).
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { repoRoot } from '@artepool/node-kit';

export interface Component {
  version: string;
  url: string;
  sha256: string;
  file: string;
}

export type ComponentName = 'node' | 'postgresql' | 'winsw';

export async function readComponents(
  file = join(repoRoot, 'tools', 'installer', 'components.json'),
): Promise<Record<ComponentName, Component>> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const out = {} as Record<ComponentName, Component>;
  for (const name of ['node', 'postgresql', 'winsw'] as const) {
    const c = parsed[name] as Partial<Component> | undefined;
    if (
      !c ||
      typeof c.url !== 'string' ||
      !c.url.startsWith('https://') ||
      typeof c.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(c.sha256) ||
      typeof c.file !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test(c.file) ||
      typeof c.version !== 'string'
    ) {
      throw new Error(
        `components.json: "${name}" needs an https url, a sha256, a file and a version.`,
      );
    }
    out[name] = c as Component;
  }
  return out;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export class HashMismatchError extends Error {
  override readonly name = 'HashMismatchError';
}

/** The file is used only if its SHA-256 is the pinned one; a wrong file is deleted. */
export async function verify(path: string, component: Component): Promise<void> {
  const actual = await sha256File(path);
  if (actual !== component.sha256) {
    await rm(path, { force: true });
    throw new HashMismatchError(
      `${component.file}: SHA-256 ${actual} is not the pinned ${component.sha256}. The download was deleted.`,
    );
  }
}

/** Downloads (unless already there and correct) and checks one component into `dir`. */
export async function fetchComponent(
  component: Component,
  dir: string,
  download: (url: string) => Promise<Readable> = async (url) => {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
    return Readable.fromWeb(response.body);
  },
): Promise<string> {
  const target = join(dir, component.file);
  if (existsSync(target)) {
    try {
      await verify(target, component);
      return target;
    } catch {
      // A partial or wrong earlier download: fetched again below.
    }
  }
  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  await pipeline(await download(component.url), createWriteStream(partial));
  await verify(partial, component);
  await rename(partial, target);
  return target;
}
