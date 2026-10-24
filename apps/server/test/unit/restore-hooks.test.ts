/**
 * The restore's Windows steps (decision 0102): the API and backup services are stopped and waited
 * for, a service that is not installed is skipped, and the copy's master key goes to the launcher
 * on its standard input (never on the command line).
 */
import { describe, expect, it } from 'vitest';
import { windowsHooks, type Exec } from '../../src/cli/restore-from-backup';

function fakeSc(states: Record<string, string[]>, missing: string[] = []) {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const exec: Exec = (file, args, input) => {
    calls.push({ file, args, ...(input === undefined ? {} : { input }) });
    const [verb, service] = args;
    if (file === 'sc.exe' && service && missing.includes(service)) {
      return Promise.reject(new Error(`sc.exe ${verb} ${service}: [SC] OpenService FAILED 1060`));
    }
    if (file === 'sc.exe' && verb === 'query' && service) {
      const next = states[service]!.length > 1 ? states[service]!.shift()! : states[service]![0]!;
      return Promise.resolve(`SERVICE_NAME: ${service}\n        STATE              : 4  ${next}\n`);
    }
    return Promise.resolve('');
  };
  return { exec, calls };
}

describe('the restore on Windows', () => {
  it('stops each service and waits until it has stopped; skips one that is not installed', async () => {
    const sc = fakeSc({ ArtepoolServer: ['RUNNING', 'STOP_PENDING', 'STOPPED'] }, [
      'ArtepoolBackup',
    ]);
    const hooks = windowsHooks({
      programDir: 'C:\\PF',
      dataDir: 'C:\\PD',
      exec: sc.exec,
      pollMs: 1,
    });
    await hooks.stopServices();
    expect(sc.calls.map((c) => c.args.join(' '))).toEqual([
      'query ArtepoolServer',
      'stop ArtepoolServer',
      'query ArtepoolServer',
      'query ArtepoolServer',
      'query ArtepoolBackup',
    ]);
  });

  it('a service already stopped is left as it is; start waits until it runs', async () => {
    const sc = fakeSc({
      ArtepoolServer: ['STOPPED', 'START_PENDING', 'RUNNING'],
      ArtepoolBackup: ['STOPPED', 'RUNNING'],
    });
    const hooks = windowsHooks({
      programDir: 'C:\\PF',
      dataDir: 'C:\\PD',
      exec: sc.exec,
      pollMs: 1,
    });
    await hooks.stopServices();
    await hooks.startServices();
    expect(sc.calls.map((c) => c.args.join(' '))).toEqual([
      'query ArtepoolServer',
      'query ArtepoolBackup',
      'start ArtepoolServer',
      'query ArtepoolServer',
      'query ArtepoolServer',
      'start ArtepoolBackup',
      'query ArtepoolBackup',
    ]);
  });

  it('gives the master key to the launcher on its standard input', async () => {
    const sc = fakeSc({});
    const hooks = windowsHooks({
      programDir: 'C:\\PF\\ARTEPOOL',
      dataDir: 'C:\\PD\\ARTEPOOL',
      exec: sc.exec,
    });
    const key = Buffer.alloc(32, 7);
    await hooks.saveMasterKey(key);
    expect(sc.calls).toHaveLength(1);
    expect(sc.calls[0]!.file).toMatch(/artepool-svc\.exe$/);
    expect(sc.calls[0]!.args).toEqual([
      '--data',
      'C:\\PD\\ARTEPOOL',
      'secrets',
      'set',
      'master-key',
    ]);
    expect(sc.calls[0]!.input).toBe(key.toString('base64'));
    expect(sc.calls[0]!.args.join(' ')).not.toContain(key.toString('base64'));
  });
});
