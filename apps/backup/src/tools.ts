/** Runs pg_dump / pg_restore without a shell; the password goes in the environment only. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { childEnv, type PgConnection } from '@artepool/node-kit';

export function pgTool(pgBin: string, name: 'pg_dump' | 'pg_restore'): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return pgBin ? join(pgBin, exe) : exe;
}

export function run(
  file: string,
  args: string[],
  connection: PgConnection,
  timeoutMs = 60 * 60 * 1000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        // Only this tool's own password: never the master key or the other roles' passwords.
        env: childEnv({ PGPASSWORD: connection.password, PGCONNECT_TIMEOUT: '15' }),
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().split('\n').slice(-3).join(' ') || error.message;
          reject(new Error(`${file.split(/[\\/]/).pop()} failed: ${detail}`));
        } else resolve(stdout);
      },
    );
  });
}

export function connectionArgs(connection: PgConnection, database = connection.database): string[] {
  return [
    `--host=${connection.host}`,
    `--port=${connection.port}`,
    `--username=${connection.user}`,
    `--dbname=${database}`,
    '--no-password',
  ];
}

export function sha256File(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest()));
  });
}
