/**
 * The release files (decision 0108): only the setups, the update packages (0115), their
 * signatures, a runtime package holding nothing but PostgreSQL, Node and WinSW, latest.json and
 * SHA256SUMS.txt may be published; anything else (source, settings, a database copy, a key, a
 * folder) stops the release. Release notes in Arabic and English are required. The update list
 * holds what the desktop app's updater and the server PC's updater read; a runtime already
 * published is pointed to, not published again.
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkPublishable,
  LATEST_URL,
  latestJson,
  readReleaseNotes,
  reusableRuntime,
  tauriReleaseConfig,
  zipEntryNames,
} from '../../src/index';

let root: string;
let n = 0;

async function folder(files: Record<string, string | Buffer>): Promise<string> {
  const dir = join(root, `case-${n++}`);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

/** A real signature from Tauri's signer (the test key of the server's signature tests). */
const tauriSignature = readFileSync(
  join(import.meta.dirname, '../../../../apps/server/test/fixtures/update-signature/data.bin.sig'),
  'utf8',
).trim();

/**
 * A zip file with these (empty, stored) entries, as bsdtar writes them; with `zip64`, the end
 * records of a ZIP64 archive.
 */
function zip(names: string[], options: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const bytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(bytes.length, 26);
    locals.push(local, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(bytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, bytes);
    offset += 30 + bytes.length;
  }
  const directory = Buffer.concat(centrals);
  const parts = [...locals, directory];
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  if (options.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(BigInt(names.length), 24);
    record.writeBigUInt64LE(BigInt(names.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
    end.writeUInt16LE(0xffff, 8);
    end.writeUInt16LE(0xffff, 10);
    end.writeUInt32LE(0xffffffff, 12);
    end.writeUInt32LE(0xffffffff, 16);
  } else {
    end.writeUInt16LE(names.length, 8);
    end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
  }
  return Buffer.concat([...parts, end]);
}

/** What `tar --format=zip -cf … runtime.json node pgsql winsw` gives (shortened). */
const runtimeNames = [
  'runtime.json',
  'node/',
  'node/node.exe',
  'pgsql/',
  'pgsql/bin/',
  'pgsql/bin/pg_ctl.exe',
  'pgsql/bin/postgres.exe',
  'pgsql/lib/libpq.dll',
  'pgsql/share/timezone/Asia/Dubai',
  'winsw/',
  'winsw/winsw.exe',
];
const runtimeName = 'ARTEPOOL-Runtime-0123456789ab.zip';

const good: Record<string, string | Buffer> = {
  'ARTEPOOL-Server-Setup-1.2.3.exe': 'MZ',
  'ARTEPOOL-Server-Setup-1.2.3.exe.sig': tauriSignature,
  'ARTEPOOL-Server-Update-1.2.3.exe': 'MZ',
  'ARTEPOOL-Server-Update-1.2.3.exe.sig': tauriSignature,
  'ARTEPOOL-Office-Setup-1.2.3.exe': 'MZ',
  'ARTEPOOL-Office-Setup-1.2.3.exe.sig': tauriSignature,
  'ARTEPOOL-Office-Update-1.2.3.exe': 'MZ',
  'ARTEPOOL-Office-Update-1.2.3.exe.sig': tauriSignature,
  [runtimeName]: zip(runtimeNames),
  [`${runtimeName}.sig`]: tauriSignature,
  'latest.json': '{"version":"1.2.3"}',
  'SHA256SUMS.txt': 'abc  ARTEPOOL-Server-Setup-1.2.3.exe\n',
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'artepool-release-'));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe('what may be published', () => {
  it('allows the setups, the update packages, the runtime, their signatures, latest.json and SHA256SUMS.txt', async () => {
    // Tauri's signatures say "signature from tauri secret key": that is not a secret.
    expect(Buffer.from(tauriSignature, 'base64').toString('utf8')).toContain('secret key');
    expect(await checkPublishable(await folder(good))).toEqual([]);
    // A release whose runtime did not change publishes no runtime package.
    const withoutRuntime = { ...good };
    delete withoutRuntime[runtimeName];
    delete withoutRuntime[`${runtimeName}.sig`];
    expect(await checkPublishable(await folder(withoutRuntime))).toEqual([]);
  });

  it('reads the names of a zip file, ZIP64 too; anything else is not a zip', async () => {
    const dir = await folder({
      'plain.zip': zip(runtimeNames),
      'big.zip': zip(runtimeNames, { zip64: true }),
      'other.zip': 'MZ not a zip',
    });
    expect(await zipEntryNames(join(dir, 'plain.zip'))).toEqual(runtimeNames);
    expect(await zipEntryNames(join(dir, 'big.zip'))).toEqual(runtimeNames);
    expect(await zipEntryNames(join(dir, 'other.zip'))).toBeNull();
  });

  it('refuses a runtime package holding anything but PostgreSQL, Node, WinSW and runtime.json', async () => {
    const cases: [string[], string[]][] = [
      [
        [...runtimeNames, 'server/server.mjs'],
        ['not allowed in a runtime package: server/server.mjs'],
      ],
      [[...runtimeNames, '.env'], ['not allowed in a runtime package: .env']],
      [[...runtimeNames, 'node/npm.cmd'], ['not allowed in a runtime package: node/npm.cmd']],
      [
        [...runtimeNames, 'pgsql/../../Windows/evil.dll'],
        ['not allowed in a runtime package: pgsql/../../Windows/evil.dll'],
      ],
      [[...runtimeNames, '/pgsql/x'], ['not allowed in a runtime package: /pgsql/x']],
      [
        [...runtimeNames, 'pgsql\\bin\\x.exe'],
        ['not allowed in a runtime package: pgsql\\bin\\x.exe'],
      ],
      [[...runtimeNames, 'C:/pgsql/x'], ['not allowed in a runtime package: C:/pgsql/x']],
      [
        runtimeNames.filter((n) => n !== 'pgsql/bin/postgres.exe'),
        ['the runtime package is missing pgsql/bin/postgres.exe'],
      ],
    ];
    for (const [names, reasons] of cases) {
      const refused = await checkPublishable(await folder({ ...good, [runtimeName]: zip(names) }));
      expect(refused, names.at(-1)).toEqual(
        reasons.map((reason) => ({ file: runtimeName, reason })),
      );
    }
    const notZip = await checkPublishable(await folder({ ...good, [runtimeName]: 'PK?' }));
    expect(notZip).toEqual([
      { file: runtimeName, reason: 'not a runtime package (not a zip file)' },
    ]);
  });

  it('refuses a .sig that is not a signature', async () => {
    const refused = await checkPublishable(
      await folder({ ...good, 'ARTEPOOL-Office-Setup-1.2.3.exe.sig': 'c2ln' }),
    );
    expect(refused).toEqual([
      { file: 'ARTEPOOL-Office-Setup-1.2.3.exe.sig', reason: 'not a signature' },
    ]);
  });

  it('refuses any other file, a folder, or nothing at all', async () => {
    for (const name of [
      'server.mjs',
      'PRD.md',
      '.env',
      'artepool-20261025.dump',
      'update.key',
      'ARTEPOOL-Server-Setup-1.2.exe',
      'ARTEPOOL-Server-Setup-1.2.3.zip',
      'artepool-erp_1.2.3_x64-setup.exe',
      'ARTEPOOL-Server-Patch-1.2.3.exe',
      'ARTEPOOL-Runtime-0123456789AB.zip',
      'ARTEPOOL-Runtime-0123456789a.zip',
      'ARTEPOOL-Runtime-0123456789ab.exe',
      'ARTEPOOL-Runtime-1.2.3.zip',
    ]) {
      const refused = await checkPublishable(await folder({ ...good, [name]: 'x' }));
      expect(refused, name).toEqual([{ file: name, reason: 'not an allowed release file' }]);
    }
    const withFolder = await folder(good);
    await mkdir(join(withFolder, 'src'));
    expect(await checkPublishable(withFolder)).toEqual([
      { file: 'src', reason: 'only files may be published, no folders or links' },
    ]);
    expect(await checkPublishable(await folder({}))).toHaveLength(1);
  });

  it('refuses a published text file holding a key, a token or a secret setting', async () => {
    const cases: [string, string][] = [
      ['latest.json', '{"x":"AGE-SECRET-KEY-1QQQ"}'],
      ['SHA256SUMS.txt', '-----BEGIN PRIVATE KEY-----'],
      ['latest.json', '{"token":"github_pat_11AAAA"}'],
      [
        'ARTEPOOL-Office-Setup-1.2.3.exe.sig',
        Buffer.from('untrusted comment: rsign encrypted secret key').toString('base64'),
      ],
      ['SHA256SUMS.txt', 'ARTEPOOL_API_PASSWORD=x'],
    ];
    for (const [name, content] of cases) {
      const refused = await checkPublishable(await folder({ ...good, [name]: content }));
      expect([...new Set(refused.map((r) => r.file))], content).toEqual([name]);
    }
  });
});

describe('release notes', () => {
  it('needs both Arabic and English, not empty, not too long', async () => {
    const dir = await folder({
      '1.2.3.ar.md': 'تحسينات في الكاشير.\n',
      '1.2.3.en.md': 'Faster POS.',
    });
    expect(await readReleaseNotes(dir, '1.2.3')).toEqual({
      ar: 'تحسينات في الكاشير.',
      en: 'Faster POS.',
    });
    await expect(readReleaseNotes(dir, '1.2.4')).rejects.toThrow(/missing/);
    const empty = await folder({ '2.0.0.ar.md': ' ', '2.0.0.en.md': 'x' });
    await expect(readReleaseNotes(empty, '2.0.0')).rejects.toThrow(/empty/);
    const long = await folder({ '3.0.0.ar.md': 'x'.repeat(4001), '3.0.0.en.md': 'x' });
    await expect(readReleaseNotes(long, '3.0.0')).rejects.toThrow(/longer/);
  });
});

describe('the update list', () => {
  const file = (name: string, signature: string, sha256: string, size: number) => ({
    name,
    signature,
    sha256,
    size,
  });
  const download = (name: string, version = '1.2.3') =>
    `https://github.com/ARTEPOOL/artepool-releases/releases/download/v${version}/${name}`;

  it('has what every updater reads, with download links and sizes', () => {
    const list = latestJson({
      version: '1.2.3',
      notes: { ar: 'عربي', en: 'English' },
      pubDate: new Date('2026-10-25T10:00:00Z'),
      server: file('ARTEPOOL-Server-Setup-1.2.3.exe', 'SSIG', 's', 290_000_000),
      serverUpdate: file('ARTEPOOL-Server-Update-1.2.3.exe', 'SUSIG', 'su', 55_000_000),
      office: file('ARTEPOOL-Office-Setup-1.2.3.exe', 'OSIG', 'o', 222_000_000),
      officeUpdate: file('ARTEPOOL-Office-Update-1.2.3.exe', 'OUSIG', 'ou', 38_000_000),
      runtime: {
        id: '0123456789ab',
        url: download(runtimeName, '1.2.0'),
        signature: 'RSIG',
        sha256: 'r',
        size: 60_000_000,
      },
    });
    expect(list).toEqual({
      version: '1.2.3',
      pub_date: '2026-10-25T10:00:00.000Z',
      notes: 'English\n\nعربي',
      notesAr: 'عربي',
      notesEn: 'English',
      // The app's built-in updater (0.8.0 and earlier) takes the small office update.
      platforms: {
        'windows-x86_64': {
          signature: 'OUSIG',
          url: download('ARTEPOOL-Office-Update-1.2.3.exe'),
        },
      },
      // What the 0.8.0 server updater reads: the full setup.
      server: {
        url: download('ARTEPOOL-Server-Setup-1.2.3.exe'),
        signature: 'SSIG',
        sha256: 's',
        size: 290_000_000,
      },
      serverUpdate: {
        url: download('ARTEPOOL-Server-Update-1.2.3.exe'),
        signature: 'SUSIG',
        sha256: 'su',
        size: 55_000_000,
        runtime: '0123456789ab',
      },
      // Published with an earlier release, pointed to from this one.
      runtime: {
        id: '0123456789ab',
        url: download(runtimeName, '1.2.0'),
        signature: 'RSIG',
        sha256: 'r',
        size: 60_000_000,
      },
      office: {
        url: download('ARTEPOOL-Office-Setup-1.2.3.exe'),
        signature: 'OSIG',
        sha256: 'o',
        size: 222_000_000,
      },
      officeUpdate: {
        url: download('ARTEPOOL-Office-Update-1.2.3.exe'),
        signature: 'OUSIG',
        sha256: 'ou',
        size: 38_000_000,
      },
    });
  });

  it('points to a runtime already published when it is this one, and only then', () => {
    const published = {
      id: '0123456789ab',
      url: download(runtimeName, '1.2.0'),
      signature: tauriSignature,
      sha256: 'a'.repeat(64),
      size: 60_000_000,
    };
    expect(reusableRuntime('0123456789ab', { version: '1.2.2', runtime: published })).toEqual(
      published,
    );
    // Another runtime, an older list without one, no list at all: published with this release.
    expect(reusableRuntime('ba9876543210', { runtime: published })).toBeNull();
    expect(reusableRuntime('0123456789ab', { version: '0.8.0', server: {} })).toBeNull();
    expect(reusableRuntime('0123456789ab', null)).toBeNull();
    // Anything odd in it is never trusted: published again.
    for (const odd of [
      {
        url: 'http://github.com/ARTEPOOL/artepool-releases/releases/download/v1.2.0/' + runtimeName,
      },
      { url: download('ARTEPOOL-Runtime-ba9876543210.zip', '1.2.0') },
      { url: `https://example.com/v1.2.0/${runtimeName}` },
      { url: download(runtimeName, 'latest') },
      { signature: 'c2ln' },
      { sha256: 'xyz' },
      { size: 0 },
      { size: '60000000' },
    ]) {
      expect(
        reusableRuntime('0123456789ab', { runtime: { ...published, ...odd } }),
        JSON.stringify(odd),
      ).toBeNull();
    }
  });

  it("puts the update key and the list's address into the app's release build", () => {
    expect(tauriReleaseConfig(' KEY \n')).toEqual({
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { pubkey: 'KEY', endpoints: [LATEST_URL] } },
    });
    expect(() => tauriReleaseConfig('')).toThrow(/update key must be created/);
  });
});
