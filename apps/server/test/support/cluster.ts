/**
 * A throwaway PostgreSQL server of its own for the power-loss test (M6.2 part I): made with initdb
 * (data checksums on, as the server setup does), started on a free port, and stopped with
 * `pg_ctl stop -m immediate`, which is what a power cut does to PostgreSQL: no checkpoint, no
 * clean shutdown; the next start recovers from the WAL. Needs PostgreSQL's server programs
 * (ARTEPOOL_PG_BIN or /usr/lib/postgresql/18/bin). As root it runs them as the postgres user.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chown, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Cluster {
  port: number;
  /** Stops it at once, as a power cut would. */
  crash(): Promise<void>;
  start(): Promise<void>;
  /** The server's log so far. */
  log(): Promise<string>;
  remove(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

export async function startCluster(superuserPassword: string): Promise<Cluster> {
  const bin = process.env.ARTEPOOL_PG_BIN || '/usr/lib/postgresql/18/bin';
  for (const tool of ['initdb', 'pg_ctl', 'postgres']) {
    if (!existsSync(join(bin, tool)))
      throw new Error(`PostgreSQL's ${tool} is not in ${bin}: install the PostgreSQL 18 server.`);
  }
  const root = process.getuid?.() === 0;
  const base = await mkdtemp(join(tmpdir(), 'artepool-cluster-'));
  if (root) {
    const id = async (flag: string) => Number((await run('id', [flag, 'postgres'])).stdout.trim());
    await chown(base, await id('-u'), await id('-g'));
  }
  const tool = (name: string, args: string[]) =>
    root
      ? run('runuser', ['-u', 'postgres', '--', join(bin, name), ...args])
      : run(join(bin, name), args);
  const data = join(base, 'data');
  const logFile = join(base, 'server.log');
  const pwfile = join(base, 'pw');
  await writeFile(pwfile, superuserPassword, { mode: 0o644 });
  await tool('initdb', [
    '-D',
    data,
    '-U',
    'postgres',
    `--pwfile=${pwfile}`,
    '-E',
    'UTF8',
    '--locale-provider=builtin',
    '--builtin-locale=C.UTF-8',
    '--auth-local=trust',
    '--auth-host=scram-sha-256',
    '--data-checksums',
  ]);
  await rm(pwfile);
  const port = await freePort();
  const options = `-p ${port} -c listen_addresses=127.0.0.1 -k ${base} -c fsync=on -c synchronous_commit=on -c full_page_writes=on`;
  const start = async () => {
    await tool('pg_ctl', ['-D', data, '-l', logFile, '-o', options, '-w', '-t', '60', 'start']);
  };
  await start();
  return {
    port,
    start,
    crash: async () => {
      await tool('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    },
    log: () => readFile(logFile, 'utf8').catch(() => ''),
    remove: async () => {
      await tool('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']).catch(() => undefined);
      await rm(base, { recursive: true, force: true });
    },
  };
}
