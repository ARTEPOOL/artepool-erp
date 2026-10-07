/**
 * The PC side of enrollment agrees byte for byte with the shared vectors (the server and the
 * Windows app's Rust code are checked against the same file).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '@artepool/node-kit';
import {
  clientProofMessage,
  enrollTranscript,
  serverProofMessage,
  type DeviceKind,
} from '@artepool/shared/contracts';
import { caFingerprint, deriveCodeKey, keyHash, normalizeCode, proof } from '../../src';

interface Vector {
  code: string;
  keySaltB64: string;
  clientNonce: string;
  serverNonce: string;
  caCertificatePem: string;
  device: { deviceCode: string; deviceName: string; deviceKind: DeviceKind; deviceKeyHash: string };
  expected: {
    codeKeyHex: string;
    caSha256Hex: string;
    transcript: string;
    serverProof: string;
    clientProof: string;
  };
}

const vectors = JSON.parse(
  readFileSync(join(repoRoot, 'db', 'test-vectors', 'enrollment.json'), 'utf8'),
) as { vectors: Vector[] };

describe('enrollment, PC side', () => {
  it.each(vectors.vectors.map((v) => [v.code, v] as const))('vector %s', async (_code, v) => {
    const codeKey = await deriveCodeKey(v.code, Buffer.from(v.keySaltB64, 'base64url'));
    expect(codeKey.toString('hex')).toBe(v.expected.codeKeyHex);
    expect(caFingerprint(v.caCertificatePem)).toBe(v.expected.caSha256Hex);
    const transcript = enrollTranscript(v.clientNonce, v.serverNonce, v.expected.caSha256Hex);
    expect(transcript).toBe(v.expected.transcript);
    expect(proof(codeKey, serverProofMessage(transcript))).toBe(v.expected.serverProof);
    expect(proof(codeKey, clientProofMessage(transcript, v.device))).toBe(v.expected.clientProof);
  });

  it('reads a code the way people type it', () => {
    expect(normalizeCode(' k7q-4mx 92p ')).toBe('K7Q4MX92P');
    expect(normalizeCode('٢٣٤-ABC-۵۶۷')).toBe('234ABC567');
  });

  it('sends only the SHA-256 of the device key', () => {
    expect(keyHash('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });
});
