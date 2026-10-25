/**
 * `pnpm build:installer` (Windows; M6.2 part F): `dist/installer/ARTEPOOL-Server-Setup-<version>.exe`.
 *
 * 1. the pinned programs are downloaded and checked (components.ts);
 * 2. everything the server PC needs is put in `dist/installer/stage`, laid out as in
 *    `C:\Program Files\ARTEPOOL`:
 *      artepool-svc.exe        the launcher (the restore screen starts it from there)
 *      artepool-emergency.exe  "ARTÉPOOL – Emergency tool" (decision 0107), administrators only
 *      node\node.exe           Node 24
 *      server\                 the packaged server (`pnpm build:server --windows`)
 *      pgsql\                  PostgreSQL 18 (bin, lib, share; no pgAdmin, no docs)
 *      winsw\winsw.exe         runs the launcher as the ArtepoolServer and ArtepoolBackup services
 *      app\artepool-erp-setup.exe   the desktop app's own installer, run silently
 *      google.json             the app's Google registration (decision 0095), when given
 * 3. NSIS makes the installer from `windows/server.nsi`; `SHA256SUMS.txt` is written beside it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { repoRoot } from '@artepool/node-kit';
import { fetchComponent, readComponents, sha256File } from './components';

const out = join(repoRoot, 'dist', 'installer');
const stage = join(out, 'stage');
const downloads = join(out, 'downloads');

/** What PostgreSQL's binaries zip holds that the server never uses. */
const PGSQL_EXCLUDE = [
  'pgsql/pgAdmin 4',
  'pgsql/StackBuilder',
  'pgsql/doc',
  'pgsql/include',
  'pgsql/symbols',
];

function makensis(): string {
  const candidates = [
    process.env.MAKENSIS,
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ].filter(Boolean) as string[];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('NSIS (makensis.exe) was not found. Install NSIS 3 or set MAKENSIS.');
  return found;
}

async function desktopInstaller(): Promise<string> {
  const dir = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const setup = (await readdir(dir)).find((f) => f.endsWith('-setup.exe'));
  if (!setup) throw new Error(`No desktop installer in ${dir}: run pnpm build:desktop first.`);
  return join(dir, setup);
}

function googleJson(): string | null {
  const desktop =
    process.env.ARTEPOOL_GOOGLE_CLIENT_ID && process.env.ARTEPOOL_GOOGLE_CLIENT_SECRET;
  const device =
    process.env.ARTEPOOL_GOOGLE_DEVICE_CLIENT_ID &&
    process.env.ARTEPOOL_GOOGLE_DEVICE_CLIENT_SECRET;
  if (!desktop && !device) return null;
  const value: Record<string, { clientId: string; clientSecret: string }> = {};
  if (desktop) {
    value.desktop = {
      clientId: process.env.ARTEPOOL_GOOGLE_CLIENT_ID!,
      clientSecret: process.env.ARTEPOOL_GOOGLE_CLIENT_SECRET!,
    };
  }
  if (device) {
    value.device = {
      clientId: process.env.ARTEPOOL_GOOGLE_DEVICE_CLIENT_ID!,
      clientSecret: process.env.ARTEPOOL_GOOGLE_DEVICE_CLIENT_SECRET!,
    };
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function buildInstaller(): Promise<string> {
  if (process.platform !== 'win32')
    throw new Error('The installer is built on Windows (NSIS, Windows tar).');
  const version = (
    JSON.parse(await readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  const components = await readComponents();
  const node = await fetchComponent(components.node, downloads);
  const pgZip = await fetchComponent(components.postgresql, downloads);
  const winsw = await fetchComponent(components.winsw, downloads);

  await rm(stage, { recursive: true, force: true });
  await mkdir(join(stage, 'node'), { recursive: true });
  await mkdir(join(stage, 'winsw'), { recursive: true });
  await mkdir(join(stage, 'app'), { recursive: true });
  await copyFile(node, join(stage, 'node', 'node.exe'));
  await copyFile(winsw, join(stage, 'winsw', 'winsw.exe'));
  await cp(join(repoRoot, 'dist', 'server'), join(stage, 'server'), { recursive: true });
  await copyFile(
    join(repoRoot, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'artepool-svc.exe'),
    join(stage, 'artepool-svc.exe'),
  );
  await copyFile(
    join(repoRoot, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'artepool-emergency.exe'),
    join(stage, 'artepool-emergency.exe'),
  );
  await copyFile(await desktopInstaller(), join(stage, 'app', 'artepool-erp-setup.exe'));
  const google = googleJson();
  if (google) await writeFile(join(stage, 'google.json'), google);

  // Windows 10 and 11 ship bsdtar, which reads zip files.
  const unpack = join(out, 'pgsql-unpack');
  await rm(unpack, { recursive: true, force: true });
  await mkdir(unpack, { recursive: true });
  execFileSync(
    'tar',
    ['-xf', pgZip, '-C', unpack, ...PGSQL_EXCLUDE.flatMap((p) => ['--exclude', p])],
    {
      stdio: 'inherit',
    },
  );
  await rename(join(unpack, 'pgsql'), join(stage, 'pgsql'));
  await rm(unpack, { recursive: true, force: true });
  for (const tool of [
    'initdb.exe',
    'pg_ctl.exe',
    'postgres.exe',
    'pg_dump.exe',
    'pg_restore.exe',
  ]) {
    if (!existsSync(join(stage, 'pgsql', 'bin', tool)))
      throw new Error(`PostgreSQL's ${tool} is missing.`);
  }

  const outFile = join(out, `ARTEPOOL-Server-Setup-${version}.exe`);
  execFileSync(
    makensis(),
    [
      '/V3',
      '/INPUTCHARSET',
      'UTF8',
      `/DVERSION=${version}`,
      `/DSTAGE=${stage}`,
      `/DOUTFILE=${outFile}`,
      join(repoRoot, 'tools', 'installer', 'windows', 'server.nsi'),
    ],
    { stdio: 'inherit' },
  );
  await writeFile(
    join(out, 'SHA256SUMS.txt'),
    `${await sha256File(outFile)}  ${basename(outFile)}\n`,
  );
  return outFile;
}
