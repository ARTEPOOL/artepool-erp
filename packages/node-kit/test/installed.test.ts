/**
 * The installed server's settings (decision 0103): one settings file with no secrets in it, never
 * `.env`; the master key only from the launcher, taken out of the environment once read; programs
 * we start (pg_dump, the browser) never inherit a secret.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyInstalledConfig,
  childEnv,
  forgetInstalledMasterKey,
  installedMasterKey,
  masterKeySource,
  readInstalledConfig,
} from '../src/index';

let dir: string;
const dataDir = join(tmpdir(), 'ARTEPOOL');

const valid = {
  version: 1,
  dataDir,
  server: { host: '0.0.0.0', port: 3100 },
  database: { name: 'artepool' },
  pgBin: join(tmpdir(), 'pgsql', 'bin'),
  google: { desktop: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'not-secret' } },
};

async function configFile(content: unknown): Promise<string> {
  const file = join(dir, 'server.json');
  await writeFile(file, JSON.stringify(content));
  return file;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artepool-installed-'));
  forgetInstalledMasterKey();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the settings file', () => {
  it('gives the settings the programs already read, with the data paths under ProgramData', async () => {
    const env: NodeJS.ProcessEnv = { ARTEPOOL_CONFIG: await configFile(valid), SERVER_PORT: '1' };
    applyInstalledConfig(env);
    expect(env).toMatchObject({
      SERVER_HOST: '0.0.0.0',
      SERVER_PORT: '3100', // the file wins over anything inherited
      PGHOST: 'localhost',
      PGPORT: '5432',
      ARTEPOOL_DB: 'artepool',
      ARTEPOOL_TLS_DIR: join(dataDir, 'secrets', 'tls'),
      ARTEPOOL_BACKUP_DIR: join(dataDir, 'backups'),
      ARTEPOOL_DRIVE_CREDENTIALS_FILE: join(dataDir, 'secrets', 'backup', 'google-drive.sealed'),
      ARTEPOOL_GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
    });
    expect(env.ARTEPOOL_API_PASSWORD).toBeUndefined();
  });

  it('refuses any setting it does not know, so a password can never be put in it', async () => {
    for (const extra of [
      { apiPassword: 'x' },
      { database: { name: 'artepool', password: 'x' } },
      { masterKey: 'x' },
    ]) {
      const file = await configFile({ ...valid, ...extra });
      expect(() => readInstalledConfig(file)).toThrow(/is not valid/);
    }
  });

  it('refuses relative paths and a missing or broken file, saying which file', async () => {
    expect(() => readInstalledConfig(join(dir, 'missing.json'))).toThrow(/could not be read/);
    const relative = await configFile({ ...valid, dataDir: 'ARTEPOOL' });
    expect(() => readInstalledConfig(relative)).toThrow(/dataDir: must be a full path/);
  });

  it('refuses the development master-key file setting', async () => {
    const env = { ARTEPOOL_CONFIG: await configFile(valid), ARTEPOOL_MASTER_KEY_FILE: 'k' };
    expect(() => applyInstalledConfig(env)).toThrow(/development setting/);
  });
});

describe('the master key on the installed server', () => {
  it('comes only from the launcher, and leaves the environment once read', async () => {
    const key = randomBytes(32);
    const env: NodeJS.ProcessEnv = {
      ARTEPOOL_CONFIG: await configFile(valid),
      ARTEPOOL_MASTER_KEY: key.toString('base64'),
    };
    const source = masterKeySource(env);
    expect(source).toEqual({ key });
    expect(env.ARTEPOOL_MASTER_KEY).toBeUndefined();
    // Read again (the backup paths after the server settings): the same key.
    expect(installedMasterKey(env)).toEqual(key);
  });

  it('is refused when missing or not 32 bytes', async () => {
    const file = await configFile(valid);
    expect(() => masterKeySource({ ARTEPOOL_CONFIG: file })).toThrow(/artepool-svc/);
    const short = {
      ARTEPOOL_CONFIG: file,
      ARTEPOOL_MASTER_KEY: randomBytes(16).toString('base64'),
    };
    expect(() => masterKeySource(short)).toThrow(/not a valid 32-byte key/);
  });

  it('is a file in development', () => {
    expect(masterKeySource({ ARTEPOOL_MASTER_KEY_FILE: '/k/master.key' })).toEqual({
      file: '/k/master.key',
    });
  });
});

describe('programs we start', () => {
  it('never inherit the master key or the role passwords', () => {
    const env = childEnv(
      { PGPASSWORD: 'backup-only' },
      {
        PATH: '/bin',
        ARTEPOOL_MASTER_KEY: 'k',
        ARTEPOOL_API_PASSWORD: 'a',
        ARTEPOOL_MAINT_PASSWORD: 'm',
        PG_SUPERUSER_PASSWORD: 's',
        PGPASSWORD: 'inherited',
        ARTEPOOL_DB: 'artepool',
      },
    );
    expect(env).toEqual({ PATH: '/bin', ARTEPOOL_DB: 'artepool', PGPASSWORD: 'backup-only' });
  });
});
