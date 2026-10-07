/**
 * Fixed examples of the enrollment protocol (decision 0024). The desktop app's Rust code checks
 * itself against the same file (db/test-vectors/enrollment.json), so both sides agree byte for byte.
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
import { caFingerprint, deriveCodeKey, proof } from '../../src/modules/devices/enrollment-crypto';

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
) as { protocol: string; vectors: Vector[] };

describe('enrollment protocol vectors', () => {
  it.each(vectors.vectors.map((v) => [v.code, v] as const))('code %s', async (_code, v) => {
    const codeKey = await deriveCodeKey(v.code, Buffer.from(v.keySaltB64, 'base64url'));
    expect(codeKey.toString('hex')).toBe(v.expected.codeKeyHex);
    expect(caFingerprint(v.caCertificatePem)).toBe(v.expected.caSha256Hex);
    const transcript = enrollTranscript(v.clientNonce, v.serverNonce, v.expected.caSha256Hex);
    expect(transcript).toBe(v.expected.transcript);
    expect(proof(codeKey, serverProofMessage(transcript))).toBe(v.expected.serverProof);
    expect(proof(codeKey, clientProofMessage(transcript, v.device))).toBe(v.expected.clientProof);
  });
});
