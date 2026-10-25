/**
 * The installed server (decision 0103, M6.2): settings come from one file,
 * `C:\ProgramData\ARTEPOOL\config\server.json`, named by ARTEPOOL_CONFIG; the secrets (the master
 * key and the database role passwords) come only from the environment, where the launcher
 * `artepool-svc` puts them after unlocking them from the DPAPI-protected store. `.env` is never
 * read there, and the settings file may not hold a secret: any key it does not know is refused.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

export const CONFIG_SETTING = 'ARTEPOOL_CONFIG';
export const MASTER_KEY_SETTING = 'ARTEPOOL_MASTER_KEY';

const absolutePath = z.string().refine((path) => isAbsolute(path), 'must be a full path');
const port = z.number().int().min(1).max(65_535);
/** The app's registration at Google (decision 0095): the same in every installation, not secret. */
const googleClient = z
  .object({ clientId: z.string().min(1), clientSecret: z.string().min(1) })
  .strict();

export const installedConfigSchema = z
  .object({
    version: z.literal(1),
    /** `C:\ProgramData\ARTEPOOL`: secrets, TLS, logs and (unless set below) the backups. */
    dataDir: absolutePath,
    server: z.object({ host: z.string().min(1), port }).strict(),
    database: z
      .object({
        host: z.string().min(1).default('localhost'),
        port: port.default(5432),
        name: z.string().regex(/^[a-z][a-z0-9_]*$/),
        /** PostgreSQL's superuser: only the restore from a backup connects as it (decision 0102). */
        superuser: z
          .string()
          .regex(/^[a-z_][a-z0-9_]*$/)
          .default('postgres'),
      })
      .strict(),
    /** The local copies on a second disk when there is one; default `<dataDir>\backups`. */
    backupDir: absolutePath.optional(),
    /** The folder with pg_dump / pg_restore of the bundled PostgreSQL. */
    pgBin: absolutePath,
    /** The pinned browser for A4 PDFs; empty = Microsoft Edge. */
    chromium: absolutePath.optional(),
    logLevel: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    google: z
      .object({ desktop: googleClient.optional(), device: googleClient.optional() })
      .strict()
      .optional(),
  })
  .strict();

export type InstalledConfig = z.infer<typeof installedConfigSchema>;

export class InstalledConfigError extends Error {
  override readonly name = 'InstalledConfigError';
}

export const isInstalled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env[CONFIG_SETTING]);

/** Reads and checks the settings file. A file that is not valid stops the program with the reason. */
export function readInstalledConfig(file: string): InstalledConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new InstalledConfigError(`The settings file ${file} could not be read.`, {
      cause: error,
    });
  }
  const parsed = installedConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`)
      .join('; ');
    throw new InstalledConfigError(`The settings file ${file} is not valid: ${problems}`);
  }
  return parsed.data;
}

/** The environment settings the server, the backup service and the console tools already read. */
export function settingsFromConfig(config: InstalledConfig): Record<string, string> {
  const secrets = join(config.dataDir, 'secrets');
  const settings: Record<string, string> = {
    SERVER_HOST: config.server.host,
    SERVER_PORT: String(config.server.port),
    LOG_LEVEL: config.logLevel,
    PGHOST: config.database.host,
    PGPORT: String(config.database.port),
    ARTEPOOL_DB: config.database.name,
    PG_SUPERUSER: config.database.superuser,
    ARTEPOOL_DATA_DIR: config.dataDir,
    ARTEPOOL_TLS_DIR: join(secrets, 'tls'),
    ARTEPOOL_BACKUP_DIR: config.backupDir ?? join(config.dataDir, 'backups'),
    ARTEPOOL_DRIVE_CREDENTIALS_FILE: join(secrets, 'backup', 'google-drive.sealed'),
    ARTEPOOL_LOG_DIR: join(config.dataDir, 'logs'),
    ARTEPOOL_SETUP_TOKEN_FILE: join(config.dataDir, 'setup', 'token'),
    ARTEPOOL_PG_BIN: config.pgBin,
  };
  if (config.chromium) settings.ARTEPOOL_CHROMIUM = config.chromium;
  const { desktop, device } = config.google ?? {};
  if (desktop) {
    settings.ARTEPOOL_GOOGLE_CLIENT_ID = desktop.clientId;
    settings.ARTEPOOL_GOOGLE_CLIENT_SECRET = desktop.clientSecret;
  }
  if (device) {
    settings.ARTEPOOL_GOOGLE_DEVICE_CLIENT_ID = device.clientId;
    settings.ARTEPOOL_GOOGLE_DEVICE_CLIENT_SECRET = device.clientSecret;
  }
  return settings;
}

/** Settings that only make sense in development; the installed server refuses to start with them. */
const DEVELOPMENT_ONLY = ['ARTEPOOL_MASTER_KEY_FILE'];

/**
 * Puts the settings file's values into the environment (they win over anything inherited). Called
 * by `loadEnv()` in installed mode, before anything reads a setting.
 */
export function applyInstalledConfig(env: NodeJS.ProcessEnv = process.env): InstalledConfig {
  const file = env[CONFIG_SETTING]!;
  for (const name of DEVELOPMENT_ONLY) {
    if (env[name]) {
      throw new InstalledConfigError(
        `${name} is a development setting; the installed server reads its secrets only from the protected store.`,
      );
    }
  }
  const config = readInstalledConfig(file);
  Object.assign(env, settingsFromConfig(config));
  return config;
}

const KEY_BYTES = 32;
let masterKey: Buffer | undefined;

/**
 * The master key given by the launcher (base64 of 32 bytes). It is taken out of the environment
 * the first time it is read, so no program started later (pg_dump, the browser) inherits it.
 */
export function installedMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  if (masterKey) return Buffer.from(masterKey);
  const text = env[MASTER_KEY_SETTING]?.trim();
  if (!text) {
    throw new InstalledConfigError(
      'The master key was not given. The installed server is started by artepool-svc, which unlocks it from the protected store.',
    );
  }
  const key = Buffer.from(text, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== text) {
    throw new InstalledConfigError(
      'The master key given by artepool-svc is not a valid 32-byte key.',
    );
  }
  delete env[MASTER_KEY_SETTING];
  masterKey = key;
  return Buffer.from(key);
}

/** Tests only: forget the key read by `installedMasterKey`. */
export function forgetInstalledMasterKey(): void {
  masterKey = undefined;
}

/** Secrets in the environment that a program started by ours (pg_dump, pg_restore) never needs. */
const SECRET_SETTING =
  /^(ARTEPOOL_MASTER_KEY|ARTEPOOL_[A-Z]+_PASSWORD|PG_SUPERUSER_PASSWORD|PGPASSWORD)$/;

/** The environment for a child program: ours without the secrets, plus `extra`. */
export function childEnv(
  extra: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_SETTING.test(name)) clean[name] = value;
  }
  return { ...clean, ...extra };
}
