/**
 * The private ARTÉPOOL certificate authority (architecture §6, decision 0024).
 *
 * - The CA carries critical **name constraints**: it can only vouch for the server names and
 *   addresses given when it was created, so even a stolen CA key cannot impersonate anything else.
 * - The server certificate is signed by it; PCs trust only this CA (pinned at enrollment).
 * - ECDSA P-256 keys; the server speaks TLS 1.3 only.
 */
// @peculiar/x509 needs the Reflect metadata API (its dependency injection uses it).
import 'reflect-metadata';
import { randomBytes, webcrypto } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { join } from 'node:path';
import { AsnConvert } from '@peculiar/asn1-schema';
import {
  GeneralName,
  GeneralSubtree,
  GeneralSubtrees,
  NameConstraints,
  id_ce_nameConstraints,
} from '@peculiar/asn1-x509';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const DAY_MS = 86_400_000;

export interface TlsNames {
  /** Host names, e.g. `localhost`, `artepool-server`. */
  dns: string[];
  /** IP addresses, e.g. `127.0.0.1`, `192.168.1.10`. */
  ips: string[];
}

export interface PemPair {
  certPem: string;
  keyPem: string;
}

export class TlsError extends Error {
  override readonly name = 'TlsError';
}

const serial = (): string => {
  const bytes = randomBytes(16);
  bytes[0] = bytes[0]! & 0x7f; // positive
  return bytes.toString('hex');
};

async function keyPem(key: webcrypto.CryptoKey): Promise<string> {
  const der = await webcrypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(der, 'PRIVATE KEY');
}

function checkNames(names: TlsNames): void {
  if (names.dns.length + names.ips.length === 0) throw new TlsError('At least one name is needed.');
  for (const dns of names.dns) {
    if (!/^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*$/.test(dns)) {
      throw new TlsError(`"${dns}" is not a valid host name.`);
    }
  }
  for (const ip of names.ips) {
    if (!isIPv4(ip) && !isIPv6(ip)) throw new TlsError(`"${ip}" is not a valid IP address.`);
  }
}

/** A new CA, valid for `years`, that can only vouch for `names`. */
export async function createCa(names: TlsNames, years = 20): Promise<PemPair> {
  checkNames(names);
  const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const permitted = new GeneralSubtrees([
    ...names.dns.map((dNSName) => new GeneralSubtree({ base: new GeneralName({ dNSName }) })),
    ...names.ips.map(
      (ip) =>
        new GeneralSubtree({
          base: new GeneralName({ iPAddress: `${ip}/${isIPv4(ip) ? 32 : 128}` }),
        }),
    ),
  ]);
  const constraints = new NameConstraints({ permittedSubtrees: permitted });
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: 'CN=ARTEPOOL Local CA, O=ARTEPOOL',
    notBefore: new Date(now - 3_600_000),
    notAfter: new Date(now + years * 365 * DAY_MS),
    signingAlgorithm: ALGORITHM,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      new x509.Extension(id_ce_nameConstraints, true, AsnConvert.serialize(constraints)),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { certPem: cert.toString('pem'), keyPem: await keyPem(keys.privateKey) };
}

/** The names a CA may vouch for, read from its name constraints. */
export function permittedNames(caCertPem: string): TlsNames {
  const ca = new x509.X509Certificate(caCertPem);
  const ext = ca.getExtension(id_ce_nameConstraints);
  if (!ext) return { dns: [], ips: [] };
  const constraints = AsnConvert.parse(ext.value, NameConstraints);
  const out: TlsNames = { dns: [], ips: [] };
  for (const subtree of constraints.permittedSubtrees ?? []) {
    if (subtree.base.dNSName) out.dns.push(subtree.base.dNSName);
    if (subtree.base.iPAddress) out.ips.push(subtree.base.iPAddress.replace(/\/\d+$/, ''));
  }
  return out;
}

const withinDns = (name: string, permitted: string[]): boolean =>
  permitted.some(
    (p) =>
      name.toLowerCase() === p.toLowerCase() || name.toLowerCase().endsWith(`.${p.toLowerCase()}`),
  );

/**
 * A server certificate for `names`, signed by the CA. Names outside the CA's constraints are
 * refused here (clients would refuse them anyway). `days` defaults to two years.
 */
export async function issueServerCert(
  ca: PemPair,
  names: TlsNames,
  days = 730,
  options: { skipConstraintCheck?: boolean } = {},
): Promise<PemPair> {
  checkNames(names);
  if (!options.skipConstraintCheck) {
    const allowed = permittedNames(ca.certPem);
    const outside = [
      ...names.dns.filter((d) => !withinDns(d, allowed.dns)),
      ...names.ips.filter((ip) => !allowed.ips.includes(ip)),
    ];
    if (outside.length > 0) {
      throw new TlsError(
        `The ARTÉPOOL CA cannot vouch for: ${outside.join(', ')}. It only covers ` +
          `${[...allowed.dns, ...allowed.ips].join(', ')}.`,
      );
    }
  }
  const caCert = new x509.X509Certificate(ca.certPem);
  const caKey = await webcrypto.subtle.importKey(
    'pkcs8',
    x509.PemConverter.decodeFirst(ca.keyPem),
    ALGORITHM,
    false,
    ['sign'],
  );
  const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${names.dns[0] ?? names.ips[0]!}, O=ARTEPOOL`,
    issuer: caCert.subject,
    notBefore: new Date(now - 3_600_000),
    notAfter: new Date(now + days * DAY_MS),
    signingAlgorithm: ALGORITHM,
    publicKey: keys.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([SERVER_AUTH], false),
      new x509.SubjectAlternativeNameExtension(
        [
          ...names.dns.map((value) => ({ type: 'dns' as const, value })),
          ...names.ips.map((value) => ({ type: 'ip' as const, value })),
        ],
        false,
      ),
      await x509.AuthorityKeyIdentifierExtension.create(caCert),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { certPem: cert.toString('pem'), keyPem: await keyPem(keys.privateKey) };
}

/** File names inside the TLS folder (development: `.secrets/tls`, ignored by Git). */
export const TLS_FILES = {
  caCert: 'ca.crt',
  caKey: 'ca.key',
  serverCert: 'server.crt',
  serverKey: 'server.key',
} as const;

/** Writes one file; private keys are readable by the owner of the file only. */
export async function writeTlsFile(dir: string, name: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  const secret = name.endsWith('.key');
  await writeFile(file, content, { mode: secret ? 0o600 : 0o644 });
  if (secret) await chmod(file, 0o600);
}

export interface ServerTls {
  caCertPem: string;
  certPem: string;
  keyPem: string;
}

/** What the API server needs at start-up. The CA private key is NOT needed and not read. */
export async function readServerTls(dir: string): Promise<ServerTls> {
  try {
    const [caCertPem, certPem, keyPem] = await Promise.all([
      readFile(join(dir, TLS_FILES.caCert), 'utf8'),
      readFile(join(dir, TLS_FILES.serverCert), 'utf8'),
      readFile(join(dir, TLS_FILES.serverKey), 'utf8'),
    ]);
    return { caCertPem, certPem, keyPem };
  } catch (error) {
    throw new TlsError(
      `The secure connection is not set up (no certificates in ${dir}). Run: pnpm tls:init`,
      { cause: error },
    );
  }
}

/** SHA-256 fingerprint of a certificate, as shown to people (AA:BB:…). */
export async function fingerprint(certPem: string): Promise<string> {
  const der = new x509.X509Certificate(certPem).rawData;
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', der));
  return [...hash].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}
