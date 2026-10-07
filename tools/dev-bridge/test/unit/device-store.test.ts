import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDevice, writeDevice, type StoredDevice } from '../../src';

const sample: StoredDevice = {
  version: 1,
  serverUrl: 'https://localhost:3100',
  caCertificatePem: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n',
  deviceKey: 'k'.repeat(43),
  keyExpiresAt: '2027-10-07T00:00:00.000Z',
  device: { id: '7', code: 'COUNTER-01', name: 'Counter', kind: 'pos' },
};

describe('device file', () => {
  it('is readable by its owner only, and reads back the same', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artepool-device-'));
    const file = join(dir, 'nested', 'device.json');
    await writeDevice(file, sample);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(0o700);
    expect(await readDevice(file)).toEqual(sample);
  });

  it('is missing before enrollment, and a damaged file is refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artepool-device-'));
    expect(await readDevice(join(dir, 'none.json'))).toBeNull();
    const bad = join(dir, 'bad.json');
    await writeFile(bad, JSON.stringify({ version: 1, serverUrl: 'x' }));
    await expect(readDevice(bad)).rejects.toThrow(/not a valid device file/);
    expect(await readFile(bad, 'utf8')).toContain('serverUrl');
  });
});
