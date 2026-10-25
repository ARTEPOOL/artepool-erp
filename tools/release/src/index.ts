/**
 * Releases (decision 0108): what the release workflow publishes to the public repository
 * `adretaae-ctrl/artepool-releases`, and the check that nothing else ever goes there.
 *
 * Published, and only this:
 *   ARTEPOOL-Server-Setup-<v>.exe (+ .sig)   the server PC's setup (also the upgrade)
 *   ARTEPOOL-Office-Setup-<v>.exe (+ .sig)   the office PCs' and the laptop's app setup
 *   latest.json                              the update list (versions, notes, signatures)
 *   SHA256SUMS.txt                           the fingerprints, for a manual check
 * No source code, no secrets, no shop data, no internal documents.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const RELEASES_REPOSITORY = 'adretaae-ctrl/artepool-releases';

/** Where the PCs read the update list: the newest release of the public repository. */
export const LATEST_URL = `https://github.com/${RELEASES_REPOSITORY}/releases/latest/download/latest.json`;

const VERSION = String.raw`\d+\.\d+\.\d+`;
const ALLOWED: RegExp[] = [
  new RegExp(`^ARTEPOOL-(Server|Office)-Setup-${VERSION}\\.exe$`),
  new RegExp(`^ARTEPOOL-(Server|Office)-Setup-${VERSION}\\.exe\\.sig$`),
  /^latest\.json$/,
  /^SHA256SUMS\.txt$/,
];

/** No installer is near this size; anything bigger is not what we meant to publish. */
export const MAX_FILE_BYTES = 1024 ** 3;

/** What must never appear in a published text file. */
const FORBIDDEN_TEXT: [RegExp, string][] = [
  [/AGE-SECRET-KEY-1/, 'a backup private key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/secret key/i, 'a signing secret key'],
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
    if (!file.endsWith('.exe')) {
      const text = await readFile(join(dir, file), 'utf8');
      // A .sig is base64 of minisign text: check what it says, too.
      const decoded = file.endsWith('.sig') ? Buffer.from(text, 'base64').toString('utf8') : '';
      for (const [pattern, what] of FORBIDDEN_TEXT) {
        if (pattern.test(text) || pattern.test(decoded)) refused.push({ file, reason: what });
      }
    }
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
}

/**
 * The update list. `platforms` is what the desktop app's updater (Tauri) reads; `server` is what
 * the server PC's updater reads; `notesAr` / `notesEn` are shown before installing.
 */
export function latestJson(input: {
  version: string;
  notes: ReleaseNotes;
  pubDate: Date;
  office: ReleaseFile;
  server: ReleaseFile;
}) {
  const url = (name: string) =>
    `https://github.com/${RELEASES_REPOSITORY}/releases/download/v${input.version}/${name}`;
  return {
    version: input.version,
    pub_date: input.pubDate.toISOString(),
    notes: `${input.notes.en}\n\n${input.notes.ar}`,
    notesAr: input.notes.ar,
    notesEn: input.notes.en,
    platforms: {
      'windows-x86_64': { signature: input.office.signature, url: url(input.office.name) },
    },
    server: {
      url: url(input.server.name),
      signature: input.server.signature,
      sha256: input.server.sha256,
    },
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
