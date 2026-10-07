import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '@artepool/node-kit';
import {
  createCa,
  fingerprint,
  issueServerCert,
  permittedNames,
  readServerTls,
  TlsError,
  writeTlsFile,
  type PemPair,
} from '../../src/index';

let ca: PemPair;

beforeAll(async () => {
  ca = await createCa({
    dns: ['localhost', 'artepool-server'],
    ips: ['127.0.0.1', '192.168.1.10'],
  });
});

describe('the ARTÉPOOL CA', () => {
  it('is a CA that may only vouch for the names it was created for', () => {
    const cert = new X509Certificate(ca.certPem);
    expect(cert.ca).toBe(true);
    expect(cert.subject).toContain('CN=ARTEPOOL Local CA');
    expect(permittedNames(ca.certPem)).toEqual({
      dns: ['localhost', 'artepool-server'],
      ips: ['127.0.0.1', '192.168.1.10'],
    });
    const years = (Date.parse(cert.validTo) - Date.now()) / (365 * 86_400_000);
    expect(years).toBeGreaterThan(19.9);
  });

  it('issues a server certificate for its names, signed by it', async () => {
    const server = await issueServerCert(ca, { dns: ['artepool-server'], ips: ['192.168.1.10'] });
    const cert = new X509Certificate(server.certPem);
    const caCert = new X509Certificate(ca.certPem);
    expect(cert.ca).toBe(false);
    expect(cert.checkIssued(caCert)).toBe(true);
    expect(cert.verify(caCert.publicKey)).toBe(true);
    expect(cert.subjectAltName).toBe('DNS:artepool-server, IP Address:192.168.1.10');
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
    expect(cert.publicKey.asymmetricKeyDetails).toEqual({ namedCurve: 'prime256v1' });
    const days = (Date.parse(cert.validTo) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(729);
    expect(days).toBeLessThan(731);
    expect(await fingerprint(ca.certPem)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('refuses names it was not created for', async () => {
    await expect(issueServerCert(ca, { dns: ['evil.example'], ips: [] })).rejects.toThrow(TlsError);
    await expect(issueServerCert(ca, { dns: [], ips: ['10.0.0.1'] })).rejects.toThrow(
      /cannot vouch/,
    );
    await expect(createCa({ dns: ['bad name'], ips: [] })).rejects.toThrow(/not a valid host name/);
  });
});

describe('the TLS files', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artepool-tls-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('keeps private keys readable by their owner only, and the server never needs the CA key', async () => {
    const server = await issueServerCert(ca, { dns: ['localhost'], ips: [] });
    await writeTlsFile(dir, 'ca.crt', ca.certPem);
    await writeTlsFile(dir, 'server.crt', server.certPem);
    await writeTlsFile(dir, 'server.key', server.keyPem);
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'server.key'))).mode & 0o777).toBe(0o600);
    }
    const loaded = await readServerTls(dir);
    expect(loaded.certPem).toBe(server.certPem);
    expect(Object.keys(loaded).sort()).toEqual(['caCertPem', 'certPem', 'keyPem']);
    await expect(readServerTls(join(dir, 'missing'))).rejects.toThrow(/pnpm tls:init/);
  });

  it('are never committed: the secrets folder is ignored by Git', async () => {
    const ignore = await readFile(join(repoRoot, '.gitignore'), 'utf8');
    expect(ignore.split('\n')).toContain('.secrets/');
  });
});
