/**
 * `pnpm tls:init [--name host]... [--ip address]... [--renew-server]`
 *
 * Creates the ARTÉPOOL CA (once; it is never replaced, because enrolled PCs trust it) and the
 * server certificate. Without names it uses this PC: localhost, 127.0.0.1, ::1 and its host name.
 * `--renew-server` issues a fresh server certificate with the same CA.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { loadEnv, repoRoot } from '@artepool/node-kit';
import {
  createCa,
  fingerprint,
  issueServerCert,
  permittedNames,
  TLS_FILES,
  TlsError,
  writeTlsFile,
  type TlsNames,
} from './index';

loadEnv();
const dir = process.env.ARTEPOOL_TLS_DIR || join(repoRoot, '.secrets', 'tls');
const args = process.argv.slice(2);
const values = (flag: string) =>
  args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]!] : []));

const requested: TlsNames = { dns: values('--name'), ips: values('--ip') };
const names: TlsNames =
  requested.dns.length + requested.ips.length > 0
    ? requested
    : { dns: ['localhost', hostname().toLowerCase()], ips: ['127.0.0.1', '::1'] };

try {
  const caCertFile = join(dir, TLS_FILES.caCert);
  let ca;
  if (existsSync(caCertFile)) {
    ca = {
      certPem: await readFile(caCertFile, 'utf8'),
      keyPem: await readFile(join(dir, TLS_FILES.caKey), 'utf8'),
    };
    console.log('The ARTÉPOOL CA already exists — kept unchanged (enrolled PCs trust it).');
  } else {
    ca = await createCa(names);
    await writeTlsFile(dir, TLS_FILES.caCert, ca.certPem);
    await writeTlsFile(dir, TLS_FILES.caKey, ca.keyPem);
    console.log('Created the ARTÉPOOL CA.');
  }
  const allowed = permittedNames(ca.certPem);
  const serverNames = requested.dns.length + requested.ips.length > 0 ? requested : allowed;
  if (!existsSync(join(dir, TLS_FILES.serverCert)) || args.includes('--renew-server')) {
    const server = await issueServerCert(ca, serverNames);
    await writeTlsFile(dir, TLS_FILES.serverCert, server.certPem);
    await writeTlsFile(dir, TLS_FILES.serverKey, server.keyPem);
    console.log(
      `Issued the server certificate for: ${[...serverNames.dns, ...serverNames.ips].join(', ')}`,
    );
  } else {
    console.log('The server certificate already exists (use --renew-server for a new one).');
  }
  console.log(`The CA can only vouch for: ${[...allowed.dns, ...allowed.ips].join(', ')}`);
  console.log(`CA fingerprint (SHA-256): ${await fingerprint(ca.certPem)}`);
  console.log(`Files: ${dir} (private keys readable by you only; never commit them).`);
} catch (error) {
  console.error(error instanceof TlsError ? error.message : `Failed: ${String(error)}`);
  process.exitCode = 1;
}
