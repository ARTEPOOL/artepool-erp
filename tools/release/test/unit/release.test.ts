/**
 * The release files (decision 0108): only the setups, their signatures, latest.json and
 * SHA256SUMS.txt may be published; anything else (source, settings, a database copy, a key, a
 * folder) stops the release. Release notes in Arabic and English are required. The update list
 * holds what the desktop app's updater and the server PC's updater read.
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
  tauriReleaseConfig,
} from '../../src/index';

let root: string;
let n = 0;

async function folder(files: Record<string, string>): Promise<string> {
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

const good = {
  'ARTEPOOL-Server-Setup-1.2.3.exe': 'MZ',
  'ARTEPOOL-Server-Setup-1.2.3.exe.sig': tauriSignature,
  'ARTEPOOL-Office-Setup-1.2.3.exe': 'MZ',
  'ARTEPOOL-Office-Setup-1.2.3.exe.sig': tauriSignature,
  'latest.json': '{"version":"1.2.3"}',
  'SHA256SUMS.txt': 'abc  ARTEPOOL-Server-Setup-1.2.3.exe\n',
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'artepool-release-'));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe('what may be published', () => {
  it('allows the setups, their signatures, latest.json and SHA256SUMS.txt', async () => {
    // Tauri's signatures say "signature from tauri secret key": that is not a secret.
    expect(Buffer.from(tauriSignature, 'base64').toString('utf8')).toContain('secret key');
    expect(await checkPublishable(await folder(good))).toEqual([]);
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
  it('has what both updaters read, with download links of this version', () => {
    const list = latestJson({
      version: '1.2.3',
      notes: { ar: 'عربي', en: 'English' },
      pubDate: new Date('2026-10-25T10:00:00Z'),
      office: { name: 'ARTEPOOL-Office-Setup-1.2.3.exe', signature: 'OSIG', sha256: 'o' },
      server: { name: 'ARTEPOOL-Server-Setup-1.2.3.exe', signature: 'SSIG', sha256: 's' },
    });
    expect(list).toEqual({
      version: '1.2.3',
      pub_date: '2026-10-25T10:00:00.000Z',
      notes: 'English\n\nعربي',
      notesAr: 'عربي',
      notesEn: 'English',
      platforms: {
        'windows-x86_64': {
          signature: 'OSIG',
          url: 'https://github.com/ARTEPOOL/artepool-releases/releases/download/v1.2.3/ARTEPOOL-Office-Setup-1.2.3.exe',
        },
      },
      server: {
        url: 'https://github.com/ARTEPOOL/artepool-releases/releases/download/v1.2.3/ARTEPOOL-Server-Setup-1.2.3.exe',
        signature: 'SSIG',
        sha256: 's',
      },
    });
  });

  it("puts the update key and the list's address into the app's release build", () => {
    expect(tauriReleaseConfig(' KEY \n')).toEqual({
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { pubkey: 'KEY', endpoints: [LATEST_URL] } },
    });
    expect(() => tauriReleaseConfig('')).toThrow(/update key must be created/);
  });
});
