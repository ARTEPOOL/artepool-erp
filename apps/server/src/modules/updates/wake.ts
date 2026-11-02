/**
 * Waking the server PC's updater at once (decision 0115). After the owner's "Check now" or
 * "Install now" the server starts the scheduled task "ARTEPOOL Updater" (`schtasks /Run`); the
 * task's own rules allow that to the server's account and nothing more. The wake carries nothing:
 * the updater decides everything from the database and the signed update list. Only on the
 * installed server PC; a failure is logged, and the task's every-minute run follows anyway.
 */
import { execFile } from 'node:child_process';
import { wakeUpdaterTask } from '../../cli/install/windows';

export type WakeUpdater = (log: (message: string) => void) => void;

export function updaterWaker(): WakeUpdater {
  const installed = process.platform === 'win32' && Boolean(process.env.ARTEPOOL_PROGRAM_DIR);
  if (!installed) return () => undefined;
  return (log) => {
    execFile('schtasks.exe', wakeUpdaterTask(), { windowsHide: true, timeout: 10_000 }, (error) => {
      if (error)
        log(`The updater could not be woken now; it runs within a minute: ${error.message}`);
    });
  };
}
