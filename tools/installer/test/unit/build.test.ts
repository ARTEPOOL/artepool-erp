/**
 * The installer build (M6.2 part F, decision 0115): the test upgrades are the next patch numbers
 * after the real version, named as test versions, never for the shop; the update package carries
 * the programs and never the runtime; every server setup is built for its runtime; the desktop
 * app's second bundle has no offline WebView2.
 */
import { describe, expect, it } from 'vitest';
import {
  makensisArgs,
  nextPatch,
  officeSetupFileName,
  officeUpdateFileName,
  serverSetupFileName,
  serverUpdateFileName,
  smallBundleConfig,
  testSetupFileName,
  testUpdateFileName,
  UPDATE_STAGE_ENTRIES,
} from '../../src/build';
import { RUNTIME_FOLDERS } from '../../src/components';

describe('the test upgrades', () => {
  it('number the next patch versions', () => {
    expect(nextPatch('0.6.2', 1)).toBe('0.6.3');
    expect(nextPatch('1.9.9', 2)).toBe('1.9.11');
  });

  it('are named -TEST', () => {
    expect(testSetupFileName('0.4.1')).toBe('ARTEPOOL-Server-Setup-0.4.1-TEST.exe');
    expect(testUpdateFileName('0.4.1')).toBe('ARTEPOOL-Server-Update-0.4.1-TEST.exe');
  });
});

describe('the release files (0115)', () => {
  it('are named as the release allows', () => {
    expect(serverSetupFileName('0.9.0')).toBe('ARTEPOOL-Server-Setup-0.9.0.exe');
    expect(serverUpdateFileName('0.9.0')).toBe('ARTEPOOL-Server-Update-0.9.0.exe');
    expect(officeSetupFileName('0.9.0')).toBe('ARTEPOOL-Office-Setup-0.9.0.exe');
    expect(officeUpdateFileName('0.9.0')).toBe('ARTEPOOL-Office-Update-0.9.0.exe');
  });

  it('the update package carries the programs, never PostgreSQL, Node or WinSW', () => {
    for (const folder of RUNTIME_FOLDERS) {
      expect(UPDATE_STAGE_ENTRIES as readonly string[]).not.toContain(folder);
    }
    expect(UPDATE_STAGE_ENTRIES).toContain('server');
    expect(UPDATE_STAGE_ENTRIES).toContain('artepool-svc.exe');
  });

  it('every server setup names the runtime it was built for; the update package says so', () => {
    const full = makensisArgs({
      version: '0.9.0',
      outFile: 'C:\\out\\ARTEPOOL-Server-Setup-0.9.0.exe',
      from: 'C:\\stage',
      runtimeId: '0123456789ab',
    });
    expect(full).toContain('/DRUNTIME_ID=0123456789ab');
    expect(full).toContain('/DSTAGE=C:\\stage');
    expect(full).not.toContain('/DUPDATE_ONLY');
    expect(full).not.toContain('/DTEST_BUILD');
    expect(full.at(-1)).toMatch(/server\.nsi$/);
    const update = makensisArgs({
      version: '0.9.1',
      outFile: 'C:\\out\\ARTEPOOL-Server-Update-0.9.1-TEST.exe',
      from: 'C:\\stage-update',
      runtimeId: '0123456789ab',
      updateOnly: true,
      testBuild: true,
    });
    expect(update).toEqual(expect.arrayContaining(['/DUPDATE_ONLY', '/DTEST_BUILD']));
  });

  it("the desktop app's second bundle installs WebView2 online only when it is missing", () => {
    expect(smallBundleConfig()).toEqual({
      bundle: {
        createUpdaterArtifacts: false,
        windows: { webviewInstallMode: { type: 'embedBootstrapper', silent: true } },
      },
    });
  });
});
