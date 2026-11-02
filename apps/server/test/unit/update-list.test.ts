/**
 * The update list as the server PC reads it (decisions 0108, 0115): what the release workflow
 * writes (tools/release `latestJson`) is what the server's updater accepts, small packages
 * included; a list from 0.8.0 (the full setup only) is still read; a small-package part that is not
 * right is left out, so the full setup is always there to fall back on.
 */
import { describe, expect, it } from 'vitest';
import { latestJson } from '@artepool/release';
import { latestSchema } from '../../src/cli/updater/steps';

const hex = (c: string) => c.repeat(64);
const download = (name: string, version = '0.9.0') =>
  `https://github.com/ARTEPOOL/artepool-releases/releases/download/v${version}/${name}`;

const published = latestJson({
  version: '0.9.0',
  notes: { ar: 'تحديث أصغر.', en: 'Smaller updates.' },
  pubDate: new Date('2026-11-05T10:00:00Z'),
  server: { name: 'ARTEPOOL-Server-Setup-0.9.0.exe', signature: 'S', sha256: hex('a'), size: 290 },
  serverUpdate: {
    name: 'ARTEPOOL-Server-Update-0.9.0.exe',
    signature: 'SU',
    sha256: hex('b'),
    size: 55,
  },
  office: { name: 'ARTEPOOL-Office-Setup-0.9.0.exe', signature: 'O', sha256: hex('c'), size: 222 },
  officeUpdate: {
    name: 'ARTEPOOL-Office-Update-0.9.0.exe',
    signature: 'OU',
    sha256: hex('d'),
    size: 38,
  },
  runtime: {
    id: '0123456789ab',
    url: download('ARTEPOOL-Runtime-0123456789ab.zip', '0.9.0'),
    signature: 'R',
    sha256: hex('e'),
    size: 60,
  },
});

describe('the update list on the server PC (0115)', () => {
  it('reads the full setup, the update package and the runtime it names', () => {
    const list = latestSchema.parse(JSON.parse(JSON.stringify(published)));
    expect(list.server).toEqual({
      url: download('ARTEPOOL-Server-Setup-0.9.0.exe'),
      signature: 'S',
      sha256: hex('a'),
      size: 290,
    });
    expect(list.serverUpdate).toEqual({
      url: download('ARTEPOOL-Server-Update-0.9.0.exe'),
      signature: 'SU',
      sha256: hex('b'),
      size: 55,
      runtime: '0123456789ab',
    });
    expect(list.runtime).toEqual({
      id: '0123456789ab',
      url: download('ARTEPOOL-Runtime-0123456789ab.zip'),
      signature: 'R',
      sha256: hex('e'),
      size: 60,
    });
  });

  it('still reads a list from 0.8.0: the full setup only', () => {
    const old = {
      version: '0.8.0',
      notesAr: 'أسرع.',
      notesEn: 'Faster.',
      server: {
        url: download('ARTEPOOL-Server-Setup-0.8.0.exe'),
        signature: 'S',
        sha256: hex('a'),
      },
    };
    const list = latestSchema.parse(old);
    expect(list.server.url).toBe(old.server.url);
    expect(list.serverUpdate).toBeUndefined();
    expect(list.runtime).toBeUndefined();
  });

  it('leaves out a small-package part that is not right; the full setup stays', () => {
    const broken = JSON.parse(JSON.stringify(published)) as Record<string, Record<string, unknown>>;
    broken.serverUpdate!.url = 'http://example.com/update.exe';
    broken.runtime!.id = 'not-an-id';
    const list = latestSchema.parse(broken);
    expect(list.serverUpdate).toBeUndefined();
    expect(list.runtime).toBeUndefined();
    expect(list.server.url).toBe(download('ARTEPOOL-Server-Setup-0.9.0.exe'));
    // The full setup itself is never optional.
    expect(() => latestSchema.parse({ ...broken, server: { url: 'http://x' } })).toThrow();
  });
});
