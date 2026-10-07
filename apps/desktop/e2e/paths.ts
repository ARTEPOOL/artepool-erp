/** Where the Playwright run keeps its state, shared by the config, the harness and the tests. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = join(tmpdir(), 'artepool-e2e');

export const E2E = {
  stateDir,
  /** The harness's control endpoint (test data, stopping the server). Local only. */
  control: 'http://127.0.0.1:1529',
  /** Three PCs, each a dev server with its own device file (decision 0021: PIN only on POS). */
  pcs: {
    office: { port: 1520, deviceFile: join(stateDir, 'office.json') },
    pos: { port: 1521, deviceFile: join(stateDir, 'pos.json') },
    fresh: { port: 1522, deviceFile: join(stateDir, 'fresh.json') },
  },
} as const;

export type Pc = keyof typeof E2E.pcs;
