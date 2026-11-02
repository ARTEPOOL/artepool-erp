/**
 * `pnpm build:installer` (Windows; M6.2 part F, decision 0115): everything a release publishes, in
 * `dist/installer`:
 *
 *   ARTEPOOL-Server-Setup-<v>.exe     the server PC's full setup (new PCs, a USB drive, the fallback)
 *   ARTEPOOL-Server-Update-<v>.exe    the server PC's programs only: no PostgreSQL, Node or WinSW,
 *                                     and its desktop app without the offline WebView2
 *   ARTEPOOL-Office-Setup-<v>.exe     the office PCs' and the laptop's full app setup (the desktop
 *                                     app's own installer, the offline WebView2 inside)
 *   ARTEPOOL-Office-Update-<v>.exe    the same app without the offline WebView2 (it installs
 *                                     WebView2 online only when it is missing)
 *   ARTEPOOL-Runtime-<id>.zip         PostgreSQL, Node, WinSW and runtime.json
 *   runtime.json, SHA256SUMS.txt
 *
 * 1. the pinned programs are downloaded and checked (components.ts);
 * 2. everything the server PC needs is put in `dist/installer/stage`, laid out as in
 *    `C:\Program Files\ARTEPOOL`:
 *      artepool-svc.exe        the launcher (the restore screen starts it from there)
 *      artepool-emergency.exe  "ARTÉPOOL – Emergency tool" (decision 0107), administrators only
 *      node\node.exe           Node 24                     ┐
 *      pgsql\                  PostgreSQL 18 (bin, lib,    │ the runtime (0115)
 *                              share; no pgAdmin, no docs) │
 *      winsw\winsw.exe         runs the launcher as the    │
 *                              ArtepoolServer and          │
 *                              ArtepoolBackup services     │
 *      runtime.json            which runtime this is       ┘
 *      server\                 the packaged server (`pnpm build:server --windows`)
 *      app\artepool-erp-setup.exe   the desktop app's own installer, run silently
 *      google.json             the app's Google registration (decision 0095), when given
 *    and the same without the runtime in `dist/installer/stage-update`, with the small app setup;
 * 3. NSIS makes both server setups from `windows/server.nsi` (/DUPDATE_ONLY for the small one);
 * 4. the desktop app is bundled a second time without the offline WebView2 (`tauri bundle`, the
 *    program itself is not built again);
 * 5. the runtime package is zipped from the stage and its names are checked like a release's.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { repoRoot } from '@artepool/node-kit';
import { runtimeFileName, runtimeZipRefusals } from '@artepool/release';
import {
  fetchComponent,
  PGSQL_EXCLUDE,
  readComponents,
  RUNTIME_FOLDERS,
  runtimeManifest,
  sha256File,
} from './components';

const out = join(repoRoot, 'dist', 'installer');
const stage = join(out, 'stage');
const updateStage = join(out, 'stage-update');
const downloads = join(out, 'downloads');
const desktopDir = join(repoRoot, 'apps', 'desktop');

/** What the update package carries from the stage: everything but the runtime and the app. */
export const UPDATE_STAGE_ENTRIES = [
  'artepool-svc.exe',
  'artepool-emergency.exe',
  'server',
  'google.json',
] as const;

/**
 * The desktop app's second bundle (0115): WebView2 no longer inside. The small bootstrapper
 * installs it online only on a PC that lacks it. Not signed by Tauri here: the release workflow
 * signs every release file the same way, with the update key.
 */
export function smallBundleConfig() {
  return {
    bundle: {
      createUpdaterArtifacts: false,
      windows: { webviewInstallMode: { type: 'embedBootstrapper', silent: true } },
    },
  };
}

export const serverSetupFileName = (version: string) => `ARTEPOOL-Server-Setup-${version}.exe`;
export const serverUpdateFileName = (version: string) => `ARTEPOOL-Server-Update-${version}.exe`;
export const officeSetupFileName = (version: string) => `ARTEPOOL-Office-Setup-${version}.exe`;
export const officeUpdateFileName = (version: string) => `ARTEPOOL-Office-Update-${version}.exe`;

/**
 * NSIS 3: MAKENSIS, an installed copy, or the one the desktop app's build (`pnpm build:desktop`,
 * always run first) downloads and checks into `%LOCALAPPDATA%\tauri\NSIS`.
 */
function makensis(): string {
  const tauri = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'tauri', 'NSIS') : null;
  const candidates = [
    process.env.MAKENSIS,
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
    tauri && join(tauri, 'makensis.exe'),
    tauri && join(tauri, 'Bin', 'makensis.exe'),
  ].filter(Boolean) as string[];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `NSIS (makensis.exe) was not found in ${candidates.join(', ')}. Install NSIS 3 or set MAKENSIS.`,
    );
  }
  return found;
}

/** The desktop app's installer as Tauri last bundled it. */
async function desktopInstaller(): Promise<string> {
  const dir = join(desktopDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const setup = (await readdir(dir)).find((f) => f.endsWith('-setup.exe'));
  if (!setup) throw new Error(`No desktop installer in ${dir}: run pnpm build:desktop first.`);
  return join(dir, setup);
}

/**
 * The desktop app bundled again without the offline WebView2 (`tauri bundle` packages the program
 * `tauri build` made; the release settings, when present, are kept).
 */
function bundleSmallDesktopApp(): void {
  const configs = [join(desktopDir, 'src-tauri', 'release.conf.json')].filter((f) => existsSync(f));
  const small = join(out, 'tauri-small.conf.json');
  execFileSync(
    'pnpm',
    [
      '--filter',
      '@artepool/desktop',
      'exec',
      'tauri',
      'bundle',
      '--bundles',
      'nsis',
      ...[...configs, small].flatMap((file) => ['--config', file]),
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
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

export interface SetupBuild {
  version: string;
  outFile: string;
  /** The staged files (`stage` or `stage-update`). */
  from: string;
  /** The runtime the setup was built for; `upgrade prepare --runtime` checks it. */
  runtimeId: string;
  /** The small update package (0115). */
  updateOnly?: boolean;
  /** A CI test upgrade, never for the shop. */
  testBuild?: boolean;
}

/** makensis's arguments for one server setup. */
export function makensisArgs(build: SetupBuild): string[] {
  return [
    '/V3',
    '/INPUTCHARSET',
    'UTF8',
    `/DVERSION=${build.version}`,
    `/DSTAGE=${build.from}`,
    `/DOUTFILE=${build.outFile}`,
    `/DRUNTIME_ID=${build.runtimeId}`,
    ...(build.updateOnly ? ['/DUPDATE_ONLY'] : []),
    ...(build.testBuild ? ['/DTEST_BUILD'] : []),
    join(repoRoot, 'tools', 'installer', 'windows', 'server.nsi'),
  ];
}

function runMakensis(build: SetupBuild): void {
  execFileSync(makensis(), makensisArgs(build), { stdio: 'inherit' });
}

/** `ARTEPOOL-Server-Setup-1.4.3-TEST.exe`: a CI test upgrade, never for the shop. */
export function testSetupFileName(version: string): string {
  return `ARTEPOOL-Server-Setup-${version}-TEST.exe`;
}

/** `ARTEPOOL-Server-Update-1.4.3-TEST.exe`: a CI test update package, never for the shop. */
export function testUpdateFileName(version: string): string {
  return `ARTEPOOL-Server-Update-${version}-TEST.exe`;
}

/** 1.4.2 + 1 → 1.4.3. */
export function nextPatch(version: string, by: number): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch! + by}`;
}

/** A runtime id no runtime has: an update package built for it is always refused. */
export const MISSING_RUNTIME_ID = '000000000000';

/**
 * `--test-upgrade` (the Windows CI test of upgrades, M6.2 part G2; update packages 0115): from the
 * same staged files, more server setups in `dist/installer/test`, never published, named
 * `…-TEST.exe` and saying on every page that they are not for the shop (a PC that ran one cannot
 * take a real version: its test migration is in none):
 *   Setup  <version+1>  one more, harmless migration (an upgrade that works);
 *   Setup  <version+2>  then a migration that fails (the database must stay unchanged and the
 *                       previous version come back);
 *   Update <version+2>  the same failing migration, as an update package;
 *   Update <version+3>  instead a second harmless migration, as an update package (it works);
 *   Update <version+4>  as <version+3>, but built for a runtime no PC has (refused, nothing changed).
 */
export async function buildTestUpgradeInstallers(
  version: string,
  runtimeId: string,
): Promise<string[]> {
  const relative = join('server', 'resources', 'db', 'migrations');
  const dirs = [join(stage, relative), join(updateStage, relative)];
  const count = (await readdir(dirs[0]!)).filter((f) => f.endsWith('.sql')).length;
  const name = (n: number, what: string) => `${String(count + n).padStart(4, '0')}_${what}.sql`;
  const migrations: Record<string, [string, string]> = {
    good: [name(1, 'ci_upgrade_check'), 'CREATE TABLE sys.ci_upgrade_check (id integer);\n'],
    broken: [
      name(2, 'ci_upgrade_broken'),
      'CREATE TABLE sys.ci_upgrade_broken (id integer);\nSELECT 1 / 0;\n',
    ],
    second: [name(2, 'ci_upgrade_update'), 'CREATE TABLE sys.ci_upgrade_update (id integer);\n'],
  };
  const put = async (key: string) => {
    for (const dir of dirs) await writeFile(join(dir, migrations[key]![0]), migrations[key]![1]);
  };
  const remove = async (key: string) => {
    for (const dir of dirs) await rm(join(dir, migrations[key]![0]), { force: true });
  };
  const dir = join(out, 'test');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  const build = (b: Omit<SetupBuild, 'testBuild'>) => {
    files.push(b.outFile);
    runMakensis({ ...b, testBuild: true });
  };
  try {
    await put('good');
    const v1 = nextPatch(version, 1);
    build({ version: v1, outFile: join(dir, testSetupFileName(v1)), from: stage, runtimeId });
    await put('broken');
    const v2 = nextPatch(version, 2);
    build({ version: v2, outFile: join(dir, testSetupFileName(v2)), from: stage, runtimeId });
    build({
      version: v2,
      outFile: join(dir, testUpdateFileName(v2)),
      from: updateStage,
      runtimeId,
      updateOnly: true,
    });
    await remove('broken');
    await put('second');
    const v3 = nextPatch(version, 3);
    build({
      version: v3,
      outFile: join(dir, testUpdateFileName(v3)),
      from: updateStage,
      runtimeId,
      updateOnly: true,
    });
    const v4 = nextPatch(version, 4);
    build({
      version: v4,
      outFile: join(dir, testUpdateFileName(v4)),
      from: updateStage,
      runtimeId: MISSING_RUNTIME_ID,
      updateOnly: true,
    });
  } finally {
    for (const key of Object.keys(migrations)) await remove(key);
  }
  return files;
}

/** "ARTEPOOL-Server-Update-0.9.0.exe  54.2 MB" lines, also in the CI job's summary. */
async function reportSizes(files: string[]): Promise<void> {
  const lines: string[] = [];
  for (const file of files) {
    const mb = (await stat(file)).size / (1024 * 1024);
    lines.push(`| ${basename(file)} | ${mb.toFixed(1)} MB |`);
  }
  const table = ['| File | Size |', '|---|---|', ...lines].join('\n');
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Release files\n\n${table}\n`);
  }
}

export async function buildInstaller(options: { testUpgrade?: boolean } = {}): Promise<string> {
  if (process.platform !== 'win32')
    throw new Error('The installer is built on Windows (NSIS, Windows tar).');
  const version = (
    JSON.parse(await readFile(join(desktopDir, 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  const components = await readComponents();
  const runtime = runtimeManifest(components);
  const node = await fetchComponent(components.node, downloads);
  const pgZip = await fetchComponent(components.postgresql, downloads);
  const winsw = await fetchComponent(components.winsw, downloads);

  await rm(stage, { recursive: true, force: true });
  await mkdir(join(stage, 'node'), { recursive: true });
  await mkdir(join(stage, 'winsw'), { recursive: true });
  await mkdir(join(stage, 'app'), { recursive: true });
  await copyFile(node, join(stage, 'node', 'node.exe'));
  await copyFile(winsw, join(stage, 'winsw', 'winsw.exe'));
  const manifest = `${JSON.stringify(runtime, null, 2)}\n`;
  await writeFile(join(stage, 'runtime.json'), manifest);
  await writeFile(join(out, 'runtime.json'), manifest);
  await cp(join(repoRoot, 'dist', 'server'), join(stage, 'server'), { recursive: true });
  await copyFile(
    join(desktopDir, 'src-tauri', 'target', 'release', 'artepool-svc.exe'),
    join(stage, 'artepool-svc.exe'),
  );
  await copyFile(
    join(desktopDir, 'src-tauri', 'target', 'release', 'artepool-emergency.exe'),
    join(stage, 'artepool-emergency.exe'),
  );
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

  // The desktop app: its full setup (offline WebView2) as `pnpm build:desktop` made it, then the
  // small one. Both share Tauri's file name, so the full one is copied away first.
  const officeSetup = join(out, officeSetupFileName(version));
  await copyFile(await desktopInstaller(), officeSetup);
  await copyFile(officeSetup, join(stage, 'app', 'artepool-erp-setup.exe'));
  await writeFile(join(out, 'tauri-small.conf.json'), JSON.stringify(smallBundleConfig()));
  bundleSmallDesktopApp();
  const officeUpdate = join(out, officeUpdateFileName(version));
  await copyFile(await desktopInstaller(), officeUpdate);

  // The update package's files: the programs, the small app setup, no runtime.
  await rm(updateStage, { recursive: true, force: true });
  await mkdir(join(updateStage, 'app'), { recursive: true });
  for (const entry of UPDATE_STAGE_ENTRIES) {
    if (existsSync(join(stage, entry))) {
      await cp(join(stage, entry), join(updateStage, entry), { recursive: true });
    }
  }
  await copyFile(officeUpdate, join(updateStage, 'app', 'artepool-erp-setup.exe'));

  const serverSetup = join(out, serverSetupFileName(version));
  runMakensis({ version, outFile: serverSetup, from: stage, runtimeId: runtime.id });
  const serverUpdate = join(out, serverUpdateFileName(version));
  runMakensis({
    version,
    outFile: serverUpdate,
    from: updateStage,
    runtimeId: runtime.id,
    updateOnly: true,
  });

  // The runtime package, checked like a release file (only these folders, safe names).
  const runtimeZip = join(out, runtimeFileName(runtime.id));
  await rm(runtimeZip, { force: true });
  execFileSync(
    'tar',
    ['--format=zip', '-cf', runtimeZip, '-C', stage, 'runtime.json', ...RUNTIME_FOLDERS],
    { stdio: 'inherit' },
  );
  const refused = await runtimeZipRefusals(runtimeZip);
  if (refused.length > 0) throw new Error(`The runtime package is refused: ${refused.join('; ')}`);

  const files = [serverSetup, serverUpdate, officeSetup, officeUpdate, runtimeZip];
  const sums = [];
  for (const file of files) sums.push(`${await sha256File(file)}  ${basename(file)}\n`);
  await writeFile(join(out, 'SHA256SUMS.txt'), sums.join(''));
  await reportSizes(files);
  if (options.testUpgrade) await buildTestUpgradeInstallers(version, runtime.id);
  return serverSetup;
}
