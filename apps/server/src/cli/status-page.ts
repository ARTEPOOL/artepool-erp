/**
 * `node status-page.mjs --host <h> --port <n> --cert <file> --key <file> --dir <updates> [--minutes
 * <n>]` — the status page (decision 0115, 0.9.0) while the server is stopped for an update; what
 * it answers is in upgrade/status-server.ts.
 *
 * `upgrade prepare` starts it from a copy of node.exe in `updates\status-page`, right after the
 * server stops (upgrade/status-page-control.ts). It stops when `updates\status-page.stop`
 * appears, when the steps file has a result, or after its time limit. If the port is still taken
 * (the server is still letting it go), it tries again every second for half a minute.
 * Its start and stop, and how many requests it answered, refused and limited, go into
 * `updates\status-page.json`. It is bundled on its own (Node's own modules only), so it runs
 * from anywhere.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readProgress } from './upgrade/progress';
import {
  statusPageFiles,
  writeStatusPageRecord,
  type StatusPageRecord,
} from './upgrade/status-page-control';
import { createStatusServer } from './upgrade/status-server';

const { values } = parseArgs({
  options: {
    host: { type: 'string' },
    port: { type: 'string' },
    cert: { type: 'string' },
    key: { type: 'string' },
    dir: { type: 'string' },
    minutes: { type: 'string' },
  },
});
if (!values.host || !values.port || !values.cert || !values.key || !values.dir) {
  console.error(
    'Use: status-page --host <h> --port <n> --cert <file> --key <file> --dir <updates>',
  );
  process.exit(2);
}
const files = statusPageFiles(values.dir);
const port = Number(values.port);
const host = values.host;
const deadline = Date.now() + Number(values.minutes ?? 60) * 60_000;
const record: StatusPageRecord = {
  pid: process.pid,
  startedAt: null,
  stoppedAt: null,
  stopReason: null,
  answers: { status: 0, refused: 0, limited: 0 },
  error: null,
};
// One write at a time, each with the record as it is then.
let saving: Promise<unknown> = Promise.resolve();
const save = () =>
  (saving = saving
    .then(() => writeStatusPageRecord(files.record, { ...record, answers: { ...record.answers } }))
    .catch(() => undefined));

const server = createStatusServer({
  cert: readFileSync(values.cert),
  key: readFileSync(values.key),
  readProgress: () => readProgress(files.progress),
  onAnswer: (answer) => {
    record.answers[answer] += 1;
  },
});

let stopping = false;
async function stop(reason: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  record.stoppedAt = new Date().toISOString();
  record.stopReason = reason;
  await save();
  process.exit(code);
}

let tries = 0;
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE' && tries < 30 && !stopping) {
    tries += 1;
    setTimeout(() => server.listen(port, host), 1000);
    return;
  }
  record.error = error.code ?? error.message;
  void stop('error', 1);
});
server.on('listening', () => {
  record.startedAt = new Date().toISOString();
  void save();
});
void save();
server.listen(port, host);

setInterval(() => {
  void (async () => {
    if (existsSync(files.stop)) return stop('asked');
    if (Date.now() > deadline) return stop('time limit');
    if ((await readProgress(files.progress))?.result) return stop('finished');
  })();
}, 500);
