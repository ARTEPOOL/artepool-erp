/**
 * An update package (decision 0115) brings the programs only; PostgreSQL, Node and WinSW are copied
 * beside them from the installed version or from the checked runtime package. Before anything is
 * stopped, the upgrade checks that this copy is the runtime the programs were built for and that
 * its programs are there; otherwise it refuses and says to use the full setup.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkRuntime, RUNTIME_FILES } from '../../src/cli/upgrade/steps';

let root: string;
let n = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'artepool-runtime-'));
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** A program folder with this runtime.json (null: none) and these runtime programs. */
async function programs(
  manifest: unknown,
  files: readonly (readonly string[])[] = RUNTIME_FILES,
): Promise<string> {
  const dir = join(root, `programs-${n++}`);
  await mkdir(dir, { recursive: true });
  if (manifest !== null) {
    await writeFile(
      join(dir, 'runtime.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    );
  }
  for (const parts of files) {
    await mkdir(dirname(join(dir, ...parts)), { recursive: true });
    await writeFile(join(dir, ...parts), 'MZ');
  }
  return dir;
}

const manifest = { id: '0123456789ab', layout: 1, node: '24.22.1', postgresql: '18.6-5' };

describe("the update package's runtime (0115)", () => {
  it('is accepted when runtime.json names it and its programs are there', async () => {
    await expect(checkRuntime(await programs(manifest), '0123456789ab')).resolves.toBeUndefined();
  });

  it('is refused, with nothing changed, when it is another runtime', async () => {
    await expect(checkRuntime(await programs(manifest), 'ba9876543210')).rejects.toMatchObject({
      step: 'checks',
      message: expect.stringMatching(
        /needs runtime ba9876543210.*have runtime 0123456789ab.*full setup.*Nothing was changed/,
      ) as unknown,
    });
  });

  it('is refused when the PC has no runtime.json (installed before 0.9.0) or an unreadable one', async () => {
    for (const missing of [null, 'not json']) {
      await expect(checkRuntime(await programs(missing), '0123456789ab')).rejects.toMatchObject({
        step: 'checks',
        message: expect.stringMatching(/no runtime\.json.*ARTEPOOL-Server-Setup/) as unknown,
      });
    }
  });

  it('is refused when one of its programs is missing', async () => {
    for (const parts of RUNTIME_FILES) {
      const files = RUNTIME_FILES.filter((p) => p !== parts);
      await expect(
        checkRuntime(await programs(manifest, files), '0123456789ab'),
        parts.join('/'),
      ).rejects.toMatchObject({
        step: 'checks',
        message: expect.stringContaining(`missing ${parts.join('\\')}`) as unknown,
      });
    }
  });
});
