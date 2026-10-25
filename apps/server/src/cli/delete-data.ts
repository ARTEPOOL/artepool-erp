/**
 * `artepool-svc run delete-data` — deleting the server PC's data (decision 0103, M6.2 part G4),
 * opened by the uninstaller in its own window when the owner ticks "Also delete the data". It
 * asks for the word DELETE and the owner's password (piped in by tests: one answer per line);
 * the steps are in delete-data/steps.ts. Exit code 0: deleted; 1: nothing was deleted.
 */
import { stdin } from 'node:process';
import { join } from 'node:path';
import { askHidden, ask, closePrompts, openConsole } from './console';
import { exec } from './restore-from-backup';
import { CONFIRMATION_WORD, deleteData, type DeleteDataResult } from './delete-data/steps';
import { InstallLog, logFileName } from './install/log';
import { windowsPlatform } from './install/windows';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: this is started by artepool-svc.`);
  return value;
}

const MESSAGES: Record<Extract<DeleteDataResult, { ok: false }>['reason'], string> = {
  not_confirmed: `${CONFIRMATION_WORD} was not typed: nothing was deleted. / ما اتكتبش ${CONFIRMATION_WORD}: مفيش حاجة اتمسحت.`,
  no_owner: 'There is no active owner: nothing was deleted. / مفيش مالك نشط: مفيش حاجة اتمسحت.',
  wrong_password:
    "The owner's password is wrong: nothing was deleted. / كلمة سر المالك غلط: مفيش حاجة اتمسحت.",
};

const deps = openConsole();
let result: DeleteDataResult | null = null;
try {
  const logs = required('ARTEPOOL_LOG_DIR');
  const dataDir = required('ARTEPOOL_DATA_DIR');
  const log = new InstallLog(join(logs, 'install', logFileName('delete-data')), () => undefined);
  console.log('ARTEPOOL — delete all the data of this server PC / مسح كل بيانات جهاز السيرفر');
  console.log(
    'The database, the secrets and the settings will be deleted for good. The backups folder stays.',
  );
  console.log('قاعدة البيانات والأسرار والإعدادات هتتمسح نهائيًا. فولدر النسخ الاحتياطية بيفضل.');
  const confirmation = await ask(
    `Type ${CONFIRMATION_WORD} to continue / اكتب ${CONFIRMATION_WORD} علشان تكمّل: `,
  );
  const password =
    confirmation.trim() === CONFIRMATION_WORD
      ? await askHidden("The owner's password / كلمة سر المالك: ")
      : '';
  closePrompts();
  const platform = windowsPlatform({
    exec,
    programDir: required('ARTEPOOL_PROGRAM_DIR'),
    pgBin: required('ARTEPOOL_PG_BIN'),
    logDir: logs,
  });
  result = await deleteData({
    db: deps.db,
    hasher: deps.hasher,
    password,
    confirmation,
    dataDir,
    closeDb: () => deps.db.destroy(),
    stopService: (service) => platform.stopService(service),
    log,
  });
  console.log(
    result.ok
      ? 'The data was deleted. The backups folder is kept. / البيانات اتمسحت. فولدر النسخ الاحتياطية متساب.'
      : MESSAGES[result.reason],
  );
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await deps.db.destroy().catch(() => undefined);
}
console.log(JSON.stringify({ result }));
process.exitCode = result?.ok ? 0 : 1;
if (stdin.isTTY) {
  // Its own window: it stays open until the owner has read the answer.
  await ask('Press Enter to close / دوس Enter علشان تقفل ').catch(() => undefined);
  closePrompts();
}
