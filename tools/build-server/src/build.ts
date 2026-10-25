/**
 * `pnpm build:server` (decision 0103, M6.2 part B): the server PC's programs as one folder that
 * the installer copies to `C:\Program Files\ARTEPOOL\server`. No source code, no `.env`, no
 * development tools:
 *
 * - `server.mjs` (the API), `backup.mjs` (the backup service and its commands), `migrate.mjs`, and
 *   the console tools (`owner-create.mjs`, `device-code.mjs`, `owner-reset-2fa.mjs`,
 *   `owner-reset-password.mjs`) and the restore from a backup (`restore.mjs`, started by the
 *   first-run wizard), bundled by esbuild with their shared code in chunk files;
 * - `node_modules/` with only the packages that cannot be bundled (the Argon2 native library, the
 *   PDF browser driver);
 * - `resources/` with the files read at run time, at the same paths as in the repository;
 * - `manifest.json`: the version and the SHA-256 of every file, checked at upgrade time.
 *
 * The bundle only runs as the installed server: without ARTEPOOL_CONFIG it refuses to start, so it
 * never looks for a `.env`. Its secrets come from the launcher (`artepool-svc`, DPAPI).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { build } from 'esbuild';
import { repoRoot } from '@artepool/node-kit';

/** The programs, by output name. */
export const ENTRY_POINTS: Record<string, string> = {
  server: 'apps/server/src/main.ts',
  backup: 'apps/backup/src/cli.ts',
  migrate: 'tools/migrate/src/cli.ts',
  'owner-create': 'apps/server/src/cli/owner-create.ts',
  'device-code': 'apps/server/src/cli/device-code.ts',
  'owner-reset-2fa': 'apps/server/src/cli/owner-reset-2fa.ts',
  'owner-reset-password': 'apps/server/src/cli/owner-reset-password.ts',
  restore: 'apps/server/src/cli/restore.ts',
  install: 'apps/server/src/cli/install.ts',
  emergency: 'apps/server/src/cli/emergency.ts',
  upgrade: 'apps/server/src/cli/upgrade.ts',
  'delete-data': 'apps/server/src/cli/delete-data.ts',
};

/** Packages kept as files: a native library, and the browser driver that loads its own files. */
const EXTERNAL_PACKAGES = ['@node-rs/argon2', 'playwright-core'];
/** Optional packages that are never installed or used (pg's native driver). */
const NEVER_USED = ['pg-native'];

const FONTSOURCE = 'apps/server/node_modules/@fontsource/ibm-plex-sans-arabic/files';

/** Files read at run time through `resourcePath`, by their path in the repository. */
export const RESOURCES: string[] = [
  'db/migrations',
  'assets/fonts/ge-ss-tv-medium.otf',
  'assets/fonts/tw-cen-mt-condensed-extra-bold.ttf',
  ...['arabic', 'latin'].flatMap((subset) =>
    [400, 700].map(
      (weight) => `${FONTSOURCE}/ibm-plex-sans-arabic-${subset}-${weight}-normal.woff2`,
    ),
  ),
  'apps/server/src/platform/auth/common-passwords.txt',
];

/**
 * Runs first in every output file: `require` for the bundled CommonJS packages, the resources
 * folder next to the bundle, and the mark that makes `loadEnv()` refuse to run without the settings
 * file.
 */
const BANNER = [
  "import { createRequire as __artepoolRequire } from 'node:module';",
  "import { fileURLToPath as __artepoolPath } from 'node:url';",
  'const require = __artepoolRequire(import.meta.url);',
  "process.env.ARTEPOOL_RESOURCES = __artepoolPath(new URL('./resources', import.meta.url));",
  'globalThis.__ARTEPOOL_PACKAGED__ = true;',
].join('\n');

export interface BuildOptions {
  outDir: string;
  /** Building the Windows package: the Windows Argon2 library must be there. */
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}

export interface Manifest {
  product: 'ARTEPOOL ERP server';
  version: string;
  commit: string | null;
  node: string;
  builtAt: string;
  files: Record<string, string>;
}

async function productVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'apps/desktop/package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

function gitCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** The package's folder as Node would find it from `fromDir` (walking up node_modules folders). */
function findPackage(name: string, fromDir: string): string | null {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/** Copies a package and the dependencies it needs (installed optional ones only) into `nodeModules`. */
async function copyPackage(
  name: string,
  fromDir: string,
  nodeModules: string,
  copied: Set<string>,
): Promise<void> {
  if (copied.has(name)) return;
  const found = findPackage(name, fromDir);
  if (!found) throw new Error(`The package ${name} is not installed. Run: pnpm install`);
  const dir = await realpath(found);
  copied.add(name);
  await cp(dir, join(nodeModules, name), {
    recursive: true,
    dereference: true,
    // Type declarations are for programmers only.
    filter: (source) => !source.endsWith('.d.ts'),
  });
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    await copyPackage(dep, dir, nodeModules, copied);
  }
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
    if (findPackage(dep, dir)) await copyPackage(dep, dir, nodeModules, copied);
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

export async function buildServer(options: BuildOptions): Promise<Manifest> {
  const { outDir, log = () => undefined } = options;
  const platform = options.platform ?? process.platform;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  log('Bundling the programs…');
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: Object.fromEntries(
      Object.entries(ENTRY_POINTS).map(([name, file]) => [name, join(repoRoot, file)]),
    ),
    outdir: outDir,
    outExtension: { '.js': '.mjs' },
    chunkNames: 'chunk-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    external: [...EXTERNAL_PACKAGES, ...NEVER_USED],
    banner: { js: BANNER },
    legalComments: 'linked',
    logLevel: 'silent',
    metafile: false,
  });
  for (const warning of result.warnings) log(`warning: ${warning.text}`);

  log('Copying the packages that are not bundled…');
  const nodeModules = join(outDir, 'node_modules');
  const copied = new Set<string>();
  for (const name of EXTERNAL_PACKAGES) {
    await copyPackage(name, join(repoRoot, 'apps', 'server'), nodeModules, copied);
  }
  if (platform === 'win32' && !copied.has('@node-rs/argon2-win32-x64-msvc')) {
    throw new Error(
      'The Windows Argon2 library (@node-rs/argon2-win32-x64-msvc) is missing: build the Windows package on Windows.',
    );
  }

  log('Copying the resources…');
  for (const path of RESOURCES) {
    const from = join(repoRoot, path);
    const to = join(outDir, 'resources', path);
    await mkdir(dirname(to), { recursive: true });
    if ((await stat(from)).isDirectory()) {
      await cp(from, to, { recursive: true, dereference: true });
    } else {
      await cp(from, to, { dereference: true });
    }
  }

  log('Writing the manifest…');
  const files: Record<string, string> = {};
  for (const file of (await listFiles(outDir)).sort()) {
    files[relative(outDir, file).split(sep).join('/')] = await sha256(file);
  }
  const manifest: Manifest = {
    product: 'ARTEPOOL ERP server',
    version: await productVersion(),
    commit: gitCommit(),
    node: process.versions.node.split('.')[0]!,
    builtAt: new Date().toISOString(),
    files,
  };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`Done: ${Object.keys(files).length} files in ${outDir}`);
  return manifest;
}
