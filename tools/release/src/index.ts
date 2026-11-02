/**
 * Releases (decision 0108): what the release workflow publishes to the public repository
 * `ARTEPOOL/artepool-releases`, and the check that nothing else ever goes there.
 *
 * Published, and only this (decision 0115 adds the small update packages and the runtime):
 *   ARTEPOOL-Server-Setup-<v>.exe (+ .sig)    the server PC's full setup: new PCs, a USB drive,
 *                                             and the fallback of every update
 *   ARTEPOOL-Server-Update-<v>.exe (+ .sig)   the server PC's programs only, without PostgreSQL,
 *                                             Node, WinSW and the offline WebView2
 *   ARTEPOOL-Office-Setup-<v>.exe (+ .sig)    the office PCs' and the laptop's full app setup
 *   ARTEPOOL-Office-Update-<v>.exe (+ .sig)   the same app without the offline WebView2
 *   ARTEPOOL-Runtime-<id>.zip (+ .sig)        PostgreSQL, Node and WinSW, only in a release whose
 *                                             runtime changed; it may hold nothing else
 *   latest.json                               the update list (versions, notes, signatures)
 *   SHA256SUMS.txt                            the fingerprints, for a manual check
 * No source code, no secrets, no shop data, no internal documents.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const RELEASES_REPOSITORY = 'ARTEPOOL/artepool-releases';

/** Where the PCs read the update list: the newest release of the public repository. */
export const LATEST_URL = `https://github.com/${RELEASES_REPOSITORY}/releases/latest/download/latest.json`;

const VERSION = String.raw`\d+\.\d+\.\d+`;

/** A runtime's id (tools/installer `runtimeManifest`): 12 hex characters. */
export const RUNTIME_ID = /^[0-9a-f]{12}$/;
export const runtimeFileName = (id: string) => `ARTEPOOL-Runtime-${id}.zip`;

const ALLOWED: RegExp[] = [
  new RegExp(`^ARTEPOOL-(Server|Office)-(Setup|Update)-${VERSION}\\.exe$`),
  new RegExp(`^ARTEPOOL-(Server|Office)-(Setup|Update)-${VERSION}\\.exe\\.sig$`),
  /^ARTEPOOL-Runtime-[0-9a-f]{12}\.zip$/,
  /^ARTEPOOL-Runtime-[0-9a-f]{12}\.zip\.sig$/,
  /^latest\.json$/,
  /^SHA256SUMS\.txt$/,
];

/** Programs and archives: their bytes are not text to read for secrets. */
const BINARY = /\.(exe|zip)$/;

/** No installer is near this size; anything bigger is not what we meant to publish. */
export const MAX_FILE_BYTES = 1024 ** 3;

/** What must never appear in a published text file. */
const FORBIDDEN_TEXT: [RegExp, string][] = [
  [/AGE-SECRET-KEY-1/, 'a backup private key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  // Tauri's secret key file says "rsign encrypted secret key"; its signatures say "signature
  // from tauri secret key", which is fine.
  [/encrypted secret key/i, 'a signing secret key'],
  [/github_pat_|ghp_[A-Za-z0-9]{20}/, 'a GitHub token'],
  [/ARTEPOOL_[A-Z_]*(PASSWORD|MASTER_KEY)/, 'a setting with a secret'],
];

export interface Refusal {
  file: string;
  reason: string;
}

/** Every file in `dir` is allowed and clean; anything else is refused (the release stops). */
export async function checkPublishable(dir: string): Promise<Refusal[]> {
  const refused: Refusal[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length === 0) refused.push({ file: dir, reason: 'nothing to publish' });
  for (const entry of entries) {
    const file = entry.name;
    if (!entry.isFile()) {
      refused.push({ file, reason: 'only files may be published, no folders or links' });
      continue;
    }
    if (!ALLOWED.some((pattern) => pattern.test(file))) {
      refused.push({ file, reason: 'not an allowed release file' });
      continue;
    }
    const { size } = await stat(join(dir, file));
    if (size > MAX_FILE_BYTES) refused.push({ file, reason: 'too big' });
    if (file.endsWith('.zip')) {
      for (const reason of await runtimeZipRefusals(join(dir, file))) {
        refused.push({ file, reason });
      }
    }
    if (!BINARY.test(file)) {
      const text = await readFile(join(dir, file), 'utf8');
      // A .sig is base64 of minisign text: check what it says, too.
      const decoded = file.endsWith('.sig') ? Buffer.from(text, 'base64').toString('utf8') : '';
      if (file.endsWith('.sig') && !decoded.startsWith('untrusted comment: signature from ')) {
        refused.push({ file, reason: 'not a signature' });
      }
      for (const [pattern, what] of FORBIDDEN_TEXT) {
        if (pattern.test(text) || pattern.test(decoded)) refused.push({ file, reason: what });
      }
    }
  }
  return refused;
}

/** The names in a zip file's central directory (ZIP64 included); null when it is not a zip. */
export async function zipEntryNames(path: string): Promise<string[] | null> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const tailSize = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailSize);
    await file.read(tail, 0, tailSize, size - tailSize);
    let end = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) return null;
    let count = tail.readUInt16LE(end + 10);
    let dirSize = tail.readUInt32LE(end + 12);
    let dirOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
      // ZIP64: the locator just before the end record points to the ZIP64 end record.
      const locator = end - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) return null;
      const zip64At = Number(tail.readBigUInt64LE(locator + 8));
      const zip64 = Buffer.alloc(56);
      await file.read(zip64, 0, 56, zip64At);
      if (zip64.readUInt32LE(0) !== 0x06064b50) return null;
      count = Number(zip64.readBigUInt64LE(32));
      dirSize = Number(zip64.readBigUInt64LE(40));
      dirOffset = Number(zip64.readBigUInt64LE(48));
    }
    if (dirOffset + dirSize > size) return null;
    const directory = Buffer.alloc(dirSize);
    await file.read(directory, 0, dirSize, dirOffset);
    const names: string[] = [];
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (at + 46 > dirSize || directory.readUInt32LE(at) !== 0x02014b50) return null;
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      names.push(directory.toString('utf8', at + 46, at + 46 + nameLength));
      at += 46 + nameLength + extraLength + commentLength;
    }
    return names;
  } finally {
    await file.close();
  }
}

/** What a runtime package must hold; anything outside these folders is refused. */
const RUNTIME_REQUIRED = [
  'runtime.json',
  'node/node.exe',
  'winsw/winsw.exe',
  'pgsql/bin/pg_ctl.exe',
  'pgsql/bin/postgres.exe',
];
const RUNTIME_ALLOWED = [
  /^runtime\.json$/,
  /^node\/(node\.exe)?$/,
  /^winsw\/(winsw\.exe)?$/,
  /^pgsql\/.*$/,
];

/** A safe relative name: forward slashes, no drive, no absolute path, no "..", no empty part. */
function safeEntryName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.includes('\\') || name.includes(':')) {
    return false;
  }
  const parts = name.replace(/\/$/, '').split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * A runtime package holds PostgreSQL, Node, WinSW and its runtime.json, and nothing else: every
 * name is checked before it is published (and again when a PC unpacks it).
 */
export async function runtimeZipRefusals(path: string): Promise<string[]> {
  const names = await zipEntryNames(path);
  if (!names) return ['not a runtime package (not a zip file)'];
  const refused: string[] = [];
  for (const name of names) {
    if (!safeEntryName(name) || !RUNTIME_ALLOWED.some((pattern) => pattern.test(name))) {
      refused.push(`not allowed in a runtime package: ${name}`);
    }
  }
  for (const name of RUNTIME_REQUIRED) {
    if (!names.includes(name)) refused.push(`the runtime package is missing ${name}`);
  }
  return refused;
}

export interface ReleaseNotes {
  ar: string;
  en: string;
}

export const MAX_NOTES_CHARS = 4000;

/** `release-notes/<version>.ar.md` and `.en.md`: both required, short, in plain words. */
export async function readReleaseNotes(dir: string, version: string): Promise<ReleaseNotes> {
  const read = async (language: 'ar' | 'en') => {
    const file = join(dir, `${version}.${language}.md`);
    let text: string;
    try {
      text = (await readFile(file, 'utf8')).trim();
    } catch {
      throw new Error(`The release notes ${file} are missing (Arabic and English are required).`);
    }
    if (text === '') throw new Error(`The release notes ${file} are empty.`);
    if (text.length > MAX_NOTES_CHARS) {
      throw new Error(`The release notes ${file} are longer than ${MAX_NOTES_CHARS} characters.`);
    }
    return text;
  };
  return { ar: await read('ar'), en: await read('en') };
}

export interface ReleaseFile {
  name: string;
  /** The Tauri signer's signature (base64 of the minisign text). */
  signature: string;
  sha256: string;
  /** In bytes: the PCs show it and add up the progress of two downloads. */
  size: number;
}

/** A download in the update list. */
export interface ListedFile {
  url: string;
  signature: string;
  sha256: string;
  size: number;
}

export interface RuntimeEntry extends ListedFile {
  id: string;
}

/** Where a file of a release is downloaded from. */
export const releaseUrl = (version: string, name: string) =>
  `https://github.com/${RELEASES_REPOSITORY}/releases/download/v${version}/${name}`;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The runtime in the update list already published, when it is this same runtime and well formed:
 * the new list points to that earlier release's file and the runtime is not published again.
 * Otherwise (a new runtime, no list, anything odd) null: the runtime is published with this release.
 */
export function reusableRuntime(id: string, previous: unknown): RuntimeEntry | null {
  if (!RUNTIME_ID.test(id) || !previous || typeof previous !== 'object') return null;
  const runtime = (previous as { runtime?: unknown }).runtime;
  if (!runtime || typeof runtime !== 'object') return null;
  const r = runtime as Record<string, unknown>;
  const url = new RegExp(
    `^${escapeRegExp(`https://github.com/${RELEASES_REPOSITORY}/releases/download/v`)}${VERSION}/${escapeRegExp(runtimeFileName(id))}$`,
  );
  if (
    r.id !== id ||
    typeof r.url !== 'string' ||
    !url.test(r.url) ||
    typeof r.signature !== 'string' ||
    !Buffer.from(r.signature, 'base64')
      .toString('utf8')
      .startsWith('untrusted comment: signature from ') ||
    typeof r.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(r.sha256) ||
    typeof r.size !== 'number' ||
    !Number.isSafeInteger(r.size) ||
    r.size <= 0
  ) {
    return null;
  }
  return { id, url: r.url, signature: r.signature, sha256: r.sha256, size: r.size };
}

/**
 * The update list (decision 0108; 0115 adds the small packages). Each updater reads its part:
 *   platforms      the desktop app's built-in updater (Tauri) in 0.8.0 and earlier: the small
 *                  office update (those PCs already have WebView2)
 *   server         the full server setup: what the 0.8.0 server updater reads, and the fallback
 *   serverUpdate   the server's programs only, for the runtime it names
 *   runtime        PostgreSQL, Node and WinSW, downloaded only when the PC's runtime differs
 *   office         the full office setup (a PC whose WebView2 is missing or broken)
 *   officeUpdate   the small office update (the laptop's and office PCs' quiet updater)
 * `notesAr` / `notesEn` are shown before installing.
 */
export function latestJson(input: {
  version: string;
  notes: ReleaseNotes;
  pubDate: Date;
  server: ReleaseFile;
  serverUpdate: ReleaseFile;
  office: ReleaseFile;
  officeUpdate: ReleaseFile;
  runtime: RuntimeEntry;
}) {
  const listed = (file: ReleaseFile): ListedFile => ({
    url: releaseUrl(input.version, file.name),
    signature: file.signature,
    sha256: file.sha256,
    size: file.size,
  });
  return {
    version: input.version,
    pub_date: input.pubDate.toISOString(),
    notes: `${input.notes.en}\n\n${input.notes.ar}`,
    notesAr: input.notes.ar,
    notesEn: input.notes.en,
    platforms: {
      'windows-x86_64': {
        signature: input.officeUpdate.signature,
        url: releaseUrl(input.version, input.officeUpdate.name),
      },
    },
    server: listed(input.server),
    serverUpdate: { ...listed(input.serverUpdate), runtime: input.runtime.id },
    runtime: {
      id: input.runtime.id,
      url: input.runtime.url,
      signature: input.runtime.signature,
      sha256: input.runtime.sha256,
      size: input.runtime.size,
    },
    office: listed(input.office),
    officeUpdate: listed(input.officeUpdate),
  };
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * The desktop app's release settings (passed to `tauri build --config`): the update key's public
 * half, where to look for updates, and signed update files.
 */
export function tauriReleaseConfig(publicKey: string) {
  if (publicKey.trim() === '') {
    throw new Error(
      'release/update-public-key.txt is empty: the update key must be created first (docs/runbooks/updates-setup.md).',
    );
  }
  return {
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey: publicKey.trim(), endpoints: [LATEST_URL] } },
  };
}
