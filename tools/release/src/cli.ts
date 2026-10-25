/**
 * The release workflow's steps (decision 0108), each refusing to go on when something is wrong:
 *
 *   pnpm release check                      the release notes (Arabic and English) are there
 *   pnpm release tauri-config <out.json>   the desktop app's release settings (update key, list)
 *   pnpm release prepare                    dist/release: the signed setups, latest.json, SHA256SUMS
 *   pnpm release publish                    the check again, then a GitHub release in the public
 *                                           repository (RELEASES_TOKEN, limited to that repository)
 */
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { repoRoot } from '@artepool/node-kit';
import {
  checkPublishable,
  latestJson,
  readReleaseNotes,
  RELEASES_REPOSITORY,
  sha256File,
  tauriReleaseConfig,
  type ReleaseFile,
} from './index';

const installerDir = join(repoRoot, 'dist', 'installer');
const releaseDir = join(repoRoot, 'dist', 'release');

async function version(): Promise<string> {
  const pkg = JSON.parse(
    await readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

async function officeSignature(): Promise<string> {
  const dir = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const sig = (await readdir(dir)).find((f) => f.endsWith('-setup.exe.sig'));
  if (!sig) throw new Error(`No signed desktop setup in ${dir}: build it with the update key.`);
  return join(dir, sig);
}

async function prepare(): Promise<void> {
  const v = await version();
  const notes = await readReleaseNotes(join(repoRoot, 'release-notes'), v);
  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });
  const files: Record<'server' | 'office', ReleaseFile> = {} as never;
  for (const [kind, name, sig] of [
    [
      'server',
      `ARTEPOOL-Server-Setup-${v}.exe`,
      join(installerDir, `ARTEPOOL-Server-Setup-${v}.exe.sig`),
    ],
    ['office', `ARTEPOOL-Office-Setup-${v}.exe`, await officeSignature()],
  ] as const) {
    await copyFile(join(installerDir, name), join(releaseDir, name));
    const signature = (await readFile(sig, 'utf8')).trim();
    await writeFile(join(releaseDir, `${name}.sig`), signature);
    files[kind] = { name, signature, sha256: await sha256File(join(releaseDir, name)) };
  }
  const list = latestJson({ version: v, notes, pubDate: new Date(), ...files });
  await writeFile(join(releaseDir, 'latest.json'), `${JSON.stringify(list, null, 2)}\n`);
  await writeFile(
    join(releaseDir, 'SHA256SUMS.txt'),
    `${files.server.sha256}  ${files.server.name}\n${files.office.sha256}  ${files.office.name}\n`,
  );
  await assertPublishable();
  console.log(`Release ${v} prepared in ${releaseDir}.`);
}

async function assertPublishable(): Promise<void> {
  const refused = await checkPublishable(releaseDir);
  if (refused.length > 0) {
    for (const r of refused) console.error(`REFUSED ${r.file}: ${r.reason}`);
    throw new Error('Nothing was published: only the allowed release files may be published.');
  }
}

async function github(path: string, init: RequestInit = {}, base = 'https://api.github.com') {
  const token = process.env.RELEASES_TOKEN;
  if (!token) throw new Error('RELEASES_TOKEN is not set (a secret of the release environment).');
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub ${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  return response.json() as Promise<Record<string, unknown>>;
}

async function publish(): Promise<void> {
  const v = await version();
  await assertPublishable();
  const notes = await readReleaseNotes(join(repoRoot, 'release-notes'), v);
  const release = await github(`/repos/${RELEASES_REPOSITORY}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: `v${v}`,
      name: `ARTEPOOL ERP ${v}`,
      body: `${notes.ar}\n\n---\n\n${notes.en}`,
      draft: true,
      make_latest: 'false',
    }),
  });
  const id = String(release.id);
  for (const name of (await readdir(releaseDir)).sort()) {
    const body = await readFile(join(releaseDir, name));
    await github(
      `/repos/${RELEASES_REPOSITORY}/releases/${id}/assets?name=${encodeURIComponent(basename(name))}`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body },
      'https://uploads.github.com',
    );
    console.log(`Uploaded ${name}`);
  }
  // Published only once every file is there, so a PC never sees half a release.
  await github(`/repos/${RELEASES_REPOSITORY}/releases/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draft: false, make_latest: 'true' }),
  });
  console.log(`Release ${v} published in ${RELEASES_REPOSITORY}.`);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command === 'tauri-config' && arg) {
    const key = await readFile(join(repoRoot, 'release', 'update-public-key.txt'), 'utf8');
    await writeFile(arg, `${JSON.stringify(tauriReleaseConfig(key), null, 2)}\n`);
  } else if (command === 'check') {
    await readReleaseNotes(join(repoRoot, 'release-notes'), await version());
  } else if (command === 'prepare') {
    await prepare();
  } else if (command === 'publish') {
    await publish();
  } else {
    throw new Error('Use: release check | tauri-config <out.json> | prepare | publish');
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
