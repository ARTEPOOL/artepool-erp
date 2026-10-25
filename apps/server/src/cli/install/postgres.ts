/**
 * The bundled PostgreSQL 18 of the installed server (M6.2 part F): the `initdb` arguments, the
 * settings added to `postgresql.conf` and the whole `pg_hba.conf`. Only this PC connects
 * (localhost), with scram-sha-256; the WAL goes to the `wal` folder for point-in-time restore
 * (decision 0086).
 */
import { ROLES } from '@artepool/node-kit';

export const SUPERUSER = 'postgres';

export function initdbArgs(pgdata: string, passwordFile: string): string[] {
  return [
    '-D',
    pgdata,
    '-U',
    SUPERUSER,
    `--pwfile=${passwordFile}`,
    '-E',
    'UTF8',
    '--locale-provider=builtin',
    '--builtin-locale=C.UTF-8',
    '--auth=scram-sha-256',
    '--data-checksums',
  ];
}

/** A Windows path inside a postgresql.conf string: backslashes doubled, quotes refused. */
function confPath(path: string): string {
  if (/['"\n]/.test(path)) throw new Error(`Unsafe path for PostgreSQL settings: ${path}`);
  return path.replace(/\\/g, '\\\\');
}

/** Appended to postgresql.conf (later lines win over the defaults above them). */
export function postgresqlSettings(options: { port: number; walDir: string }): string {
  const wal = confPath(options.walDir);
  return [
    '',
    '# --- ARTEPOOL (installed by the ARTEPOOL server setup; decision 0086) ---',
    "listen_addresses = 'localhost'",
    `port = ${options.port}`,
    "password_encryption = 'scram-sha-256'",
    'wal_level = replica',
    'archive_mode = on',
    `archive_command = 'copy "%p" "${wal}\\\\%f"'`,
    'archive_timeout = 300',
    "log_destination = 'stderr'",
    'logging_collector = on',
    "log_directory = 'log'",
    'log_rotation_age = 1d',
    'log_rotation_size = 10MB',
    '',
  ].join('\n');
}

/** The whole pg_hba.conf: this PC only, passwords as scram-sha-256. */
export function hbaConf(): string {
  return [
    '# ARTEPOOL: only this PC connects to the database, with scram-sha-256 passwords.',
    '# TYPE  DATABASE     USER              ADDRESS        METHOD',
    'host    all          all               127.0.0.1/32   scram-sha-256',
    'host    all          all               ::1/128        scram-sha-256',
    `host    replication  ${ROLES.backup}   127.0.0.1/32   scram-sha-256`,
    '',
  ].join('\n');
}
