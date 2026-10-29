/**
 * The server installation's Windows commands and settings (M6.2 part F, decision 0106: Windows'
 * own tools on every edition), built as plain data: folder rules by SID, services under their own
 * virtual accounts, the firewall rule for the local subnet only, PostgreSQL for this PC only; and
 * the install log's secret filter.
 */
import { describe, expect, it } from 'vitest';
import { InstallLog, logFileName } from '../../src/cli/install/log';
import { hbaConf, initdbArgs, postgresqlSettings } from '../../src/cli/install/postgres';
import { pcNames, windowsBuildOf } from '../../src/cli/install/steps';
import {
  firewallRule,
  updaterTask,
  icaclsGrant,
  icaclsReset,
  icaclsRestrict,
  pgCtlRegister,
  scConfigure,
  winswXml,
} from '../../src/cli/install/windows';

describe('folder access rules', () => {
  it('only SYSTEM and Administrators (by SID, any language of Windows) and the named services', () => {
    expect(
      icaclsRestrict('C:\\ProgramData\\ARTEPOOL\\backups', [
        { service: 'backup', access: 'modify' },
      ]),
    ).toEqual([
      'C:\\ProgramData\\ARTEPOOL\\backups',
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
      'NT SERVICE\\ArtepoolBackup:(OI)(CI)M',
      '/C',
      '/Q',
    ]);
    expect(icaclsGrant('D:\\x', { service: 'server', access: 'read' })).toContain(
      'NT SERVICE\\ArtepoolServer:(OI)(CI)RX',
    );
    // The inheritance flags go on the folder alone; files get its rules passed down, after a reset
    // that drops any explicit rule (an inheritance flag on a file would leave it unreadable).
    expect(icaclsRestrict('D:\\x')).not.toContain('/T');
    expect(icaclsGrant('D:\\x', { service: 'server', access: 'read' })).not.toContain('/T');
    expect(icaclsReset('D:\\x')).toEqual(['D:\\x', '/reset', '/T', '/C', '/Q']);
    // Never "Users" or "Everyone".
    expect(icaclsRestrict('D:\\x').join(' ')).not.toMatch(/Users|Everyone|S-1-1-0|S-1-5-32-545/);
  });
});

describe('services', () => {
  it('each under its own virtual account, automatic, restarted on failure', () => {
    expect(pgCtlRegister('C:\\PD\\pgdata')).toEqual([
      'register',
      '-N',
      'ArtepoolDatabase',
      '-D',
      'C:\\PD\\pgdata',
      '-S',
      'auto',
      '-w',
    ]);
    const [config, , failure] = scConfigure('server', 'API');
    expect(config).toEqual([
      'config',
      'ArtepoolServer',
      'obj=',
      'NT SERVICE\\ArtepoolServer',
      'DisplayName=',
      'ARTEPOOL Server',
      'start=',
      'auto',
    ]);
    expect(failure).toContain('restart/5000/restart/10000/restart/30000');
  });

  it('WinSW starts the launcher, after the database, with its own log folder', () => {
    const xml = winswXml({
      service: 'backup',
      launcher: 'C:\\Program Files\\ARTEPOOL\\artepool-svc.exe',
      logDir: 'C:\\ProgramData\\ARTEPOOL\\logs\\backup',
      description: 'Backups & checks',
    });
    expect(xml).toContain('<id>ArtepoolBackup</id>');
    expect(xml).toContain('<executable>C:\\Program Files\\ARTEPOOL\\artepool-svc.exe</executable>');
    expect(xml).toContain('<arguments>run backup run</arguments>');
    expect(xml).toContain('<depend>ArtepoolDatabase</depend>');
    expect(xml).toContain('<description>Backups &amp; checks</description>');
    expect(xml).not.toMatch(/password/i);
  });

  it('the firewall: the API port, local subnet, private networks; nothing for the database', () => {
    const [remove, add] = firewallRule(3100);
    expect(remove).toEqual(['advfirewall', 'firewall', 'delete', 'rule', 'name=ARTEPOOL Server']);
    expect(add).toEqual(
      expect.arrayContaining([
        'dir=in',
        'localport=3100',
        'remoteip=localsubnet',
        'profile=private',
      ]),
    );
    expect(add!.join(' ')).not.toContain('5432');
  });

  it("the updater: every 5 minutes as SYSTEM, the launcher's own updater program", () => {
    expect(updaterTask('C:\\Program Files\\ARTEPOOL\\artepool-svc.exe')).toEqual([
      '/Create',
      '/TN',
      'ARTEPOOL Updater',
      '/RU',
      'SYSTEM',
      '/SC',
      'MINUTE',
      '/MO',
      '5',
      '/RL',
      'HIGHEST',
      '/F',
      '/TR',
      '"C:\\Program Files\\ARTEPOOL\\artepool-svc.exe" run updater',
    ]);
  });
});

describe('PostgreSQL', () => {
  it('initdb: UTF-8, builtin C.UTF-8, scram-sha-256, the password from a file (never the command line)', () => {
    const args = initdbArgs('C:\\PD\\pgdata', 'C:\\PD\\setup\\initdb-1.tmp');
    expect(args).toEqual(
      expect.arrayContaining([
        '--pwfile=C:\\PD\\setup\\initdb-1.tmp',
        '--locale-provider=builtin',
        '--builtin-locale=C.UTF-8',
        '--auth=scram-sha-256',
      ]),
    );
  });

  it('this PC only, WAL to the wal folder (Windows path escaped), scram for every connection', () => {
    const conf = postgresqlSettings({ port: 5432, walDir: 'C:\\ProgramData\\ARTEPOOL\\wal' });
    expect(conf).toContain("listen_addresses = 'localhost'");
    expect(conf).toContain(
      `archive_command = 'copy "%p" "C:\\\\ProgramData\\\\ARTEPOOL\\\\wal\\\\%f"'`,
    );
    expect(conf).toContain('archive_timeout = 300');
    // A confirmed sale survives a power cut (M6.2 part I).
    for (const line of [
      'fsync = on',
      'synchronous_commit = on',
      'full_page_writes = on',
      'wal_sync_method = fsync',
    ])
      expect(conf).toContain(line);
    expect(() => postgresqlSettings({ port: 1, walDir: "C:\\it's" })).toThrow();
    const hba = hbaConf()
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
    expect(hba.every((l) => / (127\.0\.0\.1\/32|::1\/128) +scram-sha-256$/.test(l))).toBe(true);
    expect(hbaConf()).not.toMatch(/\btrust\b|0\.0\.0\.0/);
  });
});

describe('the PC', () => {
  it('Windows build from the system version', () => {
    expect(windowsBuildOf('10.0.19045')).toBe(19045);
    expect(windowsBuildOf('10.0.26100')).toBe(26100);
    expect(windowsBuildOf('6.18.44-fc')).toBeNull();
  });

  it("the certificate names: the computer's name, localhost, its LAN IPv4 addresses", () => {
    const names = pcNames('ARTEPOOL-SERVER', {
      Ethernet: [
        { address: '192.168.1.10', family: 'IPv4', internal: false } as never,
        { address: 'fe80::1', family: 'IPv6', internal: false } as never,
      ],
      Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      APIPA: [{ address: '169.254.3.4', family: 'IPv4', internal: false } as never],
    });
    expect(names).toEqual({
      dns: ['artepool-server', 'localhost'],
      ips: ['127.0.0.1', '192.168.1.10'],
    });
  });
});

describe('the install log', () => {
  it('never writes a secret: the launcher secrets, hidden values, keys and password settings', () => {
    const lines: string[] = [];
    const log = new InstallLog(null, (l) => lines.push(l), {
      ARTEPOOL_API_PASSWORD: 'api-secret-value-123',
      PG_SUPERUSER_PASSWORD: 'super-secret-value-456',
      ARTEPOOL_MASTER_KEY: 'bWFzdGVyLWtleS1iYXNlNjQ=',
      PATH: '/bin',
    });
    log.hide('the-setup-token-0123456789');
    log.line('connecting with api-secret-value-123 and super-secret-value-456');
    log.line('key bWFzdGVyLWtleS1iYXNlNjQ= token the-setup-token-0123456789');
    log.line(`private ${'AGE-SECRET-KEY-1'}${'Q'.repeat(58)} here`);
    log.line('PGPASSWORD=abc password: "xyz" client_secret=shh');
    log.line('Step 3/9: the database');
    const all = lines.join('\n');
    for (const secret of [
      'api-secret-value-123',
      'super-secret-value-456',
      'bWFzdGVyLWtleS1iYXNlNjQ=',
      'the-setup-token-0123456789',
      'AGE-SECRET-KEY-1',
      'abc',
      'xyz',
      'shh',
    ]) {
      expect(all, secret).not.toContain(secret);
    }
    expect(lines.at(-1)).toBe('Step 3/9: the database');
    expect(logFileName('install', new Date('2026-10-25T09:30:05Z'))).toBe(
      'install-20261025-093005.log',
    );
  });
});

describe('the Windows steps, in order', () => {
  it('the database service: registered, its own account, its data folder, started and waited for', async () => {
    const { windowsPlatform } = await import('../../src/cli/install/windows');
    const calls: string[] = [];
    let queries = 0;
    const platform = windowsPlatform({
      exec: (file, args) => {
        calls.push(`${file.split(/[\\/]/).pop()} ${args.join(' ')}`);
        if (args[0] === 'query') {
          queries++;
          return Promise.resolve(`STATE : 4  ${queries > 1 ? 'RUNNING' : 'START_PENDING'}`);
        }
        return Promise.resolve('');
      },
      programDir: 'C:\\PF\\ARTEPOOL',
      pgBin: 'C:\\PF\\ARTEPOOL\\pgsql\\bin',
      logDir: 'C:\\PD\\logs',
      pollMs: 1,
    });
    await platform.startDatabaseService('C:\\PD\\pgdata');
    expect(calls).toEqual([
      'pg_ctl.exe register -N ArtepoolDatabase -D C:\\PD\\pgdata -S auto -w',
      'sc.exe config ArtepoolDatabase obj= NT SERVICE\\ArtepoolDatabase DisplayName= ARTEPOOL Database start= auto',
      'sc.exe description ArtepoolDatabase ARTEPOOL ERP database (PostgreSQL 18, this PC only).',
      'sc.exe failure ArtepoolDatabase reset= 86400 actions= restart/5000/restart/10000/restart/30000',
      'icacls.exe C:\\PD\\pgdata /grant NT SERVICE\\ArtepoolDatabase:(OI)(CI)F /C /Q',
      'sc.exe start ArtepoolDatabase',
      'sc.exe query ArtepoolDatabase',
      'sc.exe query ArtepoolDatabase',
    ]);
  });
});

describe('stopping and starting for an upgrade', () => {
  it('a service already stopped or missing, or already running, is fine', async () => {
    const { windowsPlatform } = await import('../../src/cli/install/windows');
    const calls: string[] = [];
    const platform = windowsPlatform({
      exec: (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);
        if (args[0] === 'stop') {
          return Promise.reject(new Error('sc.exe stop: [SC] ControlService FAILED 1062'));
        }
        if (args[0] === 'start') {
          return Promise.reject(new Error('sc.exe start: [SC] StartService FAILED 1056'));
        }
        return Promise.resolve(
          calls.filter((c) => c.includes('stop')).length >
            calls.filter((c) => c.includes('start')).length
            ? 'STATE : 1  STOPPED'
            : 'STATE : 4  RUNNING',
        );
      },
      programDir: 'C:\\PF\\ARTEPOOL',
      pgBin: 'C:\\PF\\ARTEPOOL\\pgsql\\bin',
      logDir: 'C:\\PD\\logs',
      pollMs: 1,
    });
    await platform.stopService('server');
    await platform.startService('server');
    expect(calls).toEqual([
      'sc.exe stop ArtepoolServer',
      'sc.exe query ArtepoolServer',
      'sc.exe start ArtepoolServer',
      'sc.exe query ArtepoolServer',
    ]);
  });

  it('another failure to stop is not hidden', async () => {
    const { windowsPlatform } = await import('../../src/cli/install/windows');
    const platform = windowsPlatform({
      exec: () =>
        Promise.reject(new Error('sc.exe stop: [SC] OpenService FAILED 5: Access is denied.')),
      programDir: 'C:\\PF\\ARTEPOOL',
      pgBin: 'C:\\PF\\ARTEPOOL\\pgsql\\bin',
      logDir: 'C:\\PD\\logs',
      pollMs: 1,
    });
    await expect(platform.stopService('server')).rejects.toThrow(/Access is denied/);
  });
});
