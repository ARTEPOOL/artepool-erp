/**
 * What the automatic server certificate renewal needs (M6.2 part H3): the names a certificate is
 * for, its expiry, and a local TLS 1.3 check that a new certificate and key really work with the
 * CA before they are used.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  certificateExpiry,
  checkServerPair,
  createCa,
  issueServerCert,
  serverCertNames,
  type PemPair,
} from '../../src/index';

const NAMES = { dns: ['localhost', 'artepool-server'], ips: ['127.0.0.1'] };
let ca: PemPair;
let otherCa: PemPair;

beforeAll(async () => {
  ca = await createCa(NAMES);
  otherCa = await createCa(NAMES);
});
afterAll(() => undefined);

describe('a server certificate', () => {
  it('tells the names it is for and when it ends', async () => {
    const pair = await issueServerCert(ca, NAMES, 30);
    expect(serverCertNames(pair.certPem)).toEqual(NAMES);
    const days = (certificateExpiry(pair.certPem).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });
});

describe('the local check before switching', () => {
  it('accepts a certificate and key from the CA, for every name', async () => {
    await expect(checkServerPair(await issueServerCert(ca, NAMES), ca.certPem)).resolves.toBe(
      undefined,
    );
  });

  it('refuses a certificate from another CA', async () => {
    await expect(
      checkServerPair(await issueServerCert(otherCa, NAMES), ca.certPem),
    ).rejects.toThrow(/not accepted/);
  });

  it('refuses a certificate with a key that does not match it', async () => {
    const one = await issueServerCert(ca, NAMES);
    const two = await issueServerCert(ca, NAMES);
    await expect(
      checkServerPair({ certPem: one.certPem, keyPem: two.keyPem }, ca.certPem),
    ).rejects.toThrow();
  });
});
