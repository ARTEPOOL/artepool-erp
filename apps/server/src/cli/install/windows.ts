/**
 * What the installation does through Windows' own tools, present on every edition (decision
 * 0106): folder access rules (`icacls`), services (`sc.exe`, `pg_ctl register`, WinSW) and the
 * firewall (`netsh advfirewall`). The command lines are built here, as plain data, so they are
 * tested on any system; `windowsPlatform` runs them.
 *
 * Accounts are named by SID where Windows translates names (an Arabic Windows calls
 * "Administrators" something else): SYSTEM is S-1-5-18, Administrators S-1-5-32-544. A service's
 * own virtual account is `NT SERVICE\<service name>`, which exists once the service does.
 */
import { createHash } from 'node:crypto';
import { copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from '../restore-from-backup';

export const SERVICES = {
  database: { name: 'ArtepoolDatabase', display: 'ARTEPOOL Database' },
  server: { name: 'ArtepoolServer', display: 'ARTEPOOL Server' },
  backup: { name: 'ArtepoolBackup', display: 'ARTEPOOL Backup' },
} as const;

export type ServiceKey = keyof typeof SERVICES;
export type Access = 'read' | 'modify' | 'full';

export interface Grant {
  service: ServiceKey;
  access: Access;
}

const SYSTEM = '*S-1-5-18';
const ADMINISTRATORS = '*S-1-5-32-544';
const USERS = '*S-1-5-32-545';
const RIGHTS: Record<Access, string> = { read: 'RX', modify: 'M', full: 'F' };

export const serviceAccount = (service: ServiceKey) => `NT SERVICE\\${SERVICES[service].name}`;

/**
 * First step of closing a folder: everything in it (and the folder) back to plain inherited
 * rules, dropping any explicit ones (initdb leaves its own on the data folder). Valid on files,
 * unlike the inheritance flags of the next step.
 */
export function icaclsReset(folder: string): string[] {
  return [folder, '/reset', '/T', '/C', '/Q'];
}

/**
 * Second step: only SYSTEM, Administrators and the given services may open `folder`. Set on the
 * folder alone; Windows passes these inheritable rules down to everything in it.
 */
export function icaclsRestrict(folder: string, grants: Grant[] = []): string[] {
  return [
    folder,
    '/inheritance:r',
    '/grant:r',
    `${SYSTEM}:(OI)(CI)F`,
    `${ADMINISTRATORS}:(OI)(CI)F`,
    ...grants.map((g) => `${serviceAccount(g.service)}:(OI)(CI)${RIGHTS[g.access]}`),
    '/C',
    '/Q',
  ];
}

/**
 * The ARTEPOOL data folder itself (M6.4): SYSTEM and Administrators in full; standard accounts may
 * read and list it, nothing more, and nothing of theirs is passed down (ProgramData's default let
 * any account create files in it, the SYSTEM updater's folder included).
 */
export function icaclsDataRoot(folder: string): string[] {
  return [
    folder,
    '/inheritance:r',
    '/grant:r',
    `${SYSTEM}:(OI)(CI)F`,
    `${ADMINISTRATORS}:(OI)(CI)F`,
    `${USERS}:RX`,
    '/C',
    '/Q',
  ];
}

/**
 * The PC's shared enrollment (`device`, M6.4): the owner's and the cashier's Windows accounts read
 * it and renew the device key in it; the file itself is sealed for this PC only.
 */
export function icaclsSharedDevice(folder: string): string[] {
  return [
    folder,
    '/inheritance:r',
    '/grant:r',
    `${SYSTEM}:(OI)(CI)F`,
    `${ADMINISTRATORS}:(OI)(CI)F`,
    `${USERS}:(OI)(CI)M`,
    '/C',
    '/Q',
  ];
}

/** Adds one service's rights to a folder already restricted (passed down to its contents). */
export function icaclsGrant(folder: string, grant: Grant): string[] {
  return [
    folder,
    '/grant',
    `${serviceAccount(grant.service)}:(OI)(CI)${RIGHTS[grant.access]}`,
    '/C',
    '/Q',
  ];
}

export function pgCtlRegister(pgdata: string): string[] {
  return ['register', '-N', SERVICES.database.name, '-D', pgdata, '-S', 'auto', '-w'];
}

/** After a service exists: its own virtual account, its display name, restart on failure. */
export function scConfigure(service: ServiceKey, description: string): string[][] {
  const { name, display } = SERVICES[service];
  return [
    ['config', name, 'obj=', serviceAccount(service), 'DisplayName=', display, 'start=', 'auto'],
    ['description', name, description],
    ['failure', name, 'reset=', '86400', 'actions=', 'restart/5000/restart/10000/restart/30000'],
  ];
}

/** WinSW runs the launcher as the service (`artepool-svc run server|backup`). */
export function winswXml(options: {
  service: 'server' | 'backup';
  launcher: string;
  logDir: string;
  description: string;
}): string {
  const { name, display } = SERVICES[options.service];
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return [
    '<service>',
    `  <id>${name}</id>`,
    `  <name>${esc(display)}</name>`,
    `  <description>${esc(options.description)}</description>`,
    `  <executable>${esc(options.launcher)}</executable>`,
    // The backup program's `run` is its service mode (alone it makes one copy and exits).
    `  <arguments>${options.service === 'backup' ? 'run backup run' : 'run server'}</arguments>`,
    '  <startmode>Automatic</startmode>',
    `  <depend>${SERVICES.database.name}</depend>`,
    '  <onfailure action="restart" delay="10 sec"/>',
    '  <resetfailure>1 hour</resetfailure>',
    '  <stoptimeout>30 sec</stoptimeout>',
    `  <logpath>${esc(options.logDir)}</logpath>`,
    '  <log mode="roll-by-size">',
    '    <sizeThreshold>10240</sizeThreshold>',
    '    <keepFiles>8</keepFiles>',
    '  </log>',
    '</service>',
    '',
  ].join('\n');
}

export const FIREWALL_RULE = 'ARTEPOOL Server';

/** One inbound rule: the API port, from the local subnet only, on private networks. */
export function firewallRule(port: number): string[][] {
  return [
    ['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE}`],
    [
      'advfirewall',
      'firewall',
      'add',
      'rule',
      `name=${FIREWALL_RULE}`,
      'dir=in',
      'action=allow',
      'protocol=TCP',
      `localport=${port}`,
      'remoteip=localsubnet',
      'profile=private',
    ],
  ];
}

export const UPDATER_TASK = 'ARTEPOOL Updater';

/**
 * A service's own SID (`NT SERVICE\<name>`): S-1-5-80 and the SHA-1 of its name in capitals
 * (UTF-16LE), read as five little-endian numbers. The same on every PC, so the task's security
 * descriptor can name it before Windows has ever shown it.
 */
export function serviceSid(name: string): string {
  const hash = createHash('sha1').update(Buffer.from(name.toUpperCase(), 'utf16le')).digest();
  const parts = [0, 4, 8, 12, 16].map((at) => hash.readUInt32LE(at));
  return `S-1-5-80-${parts.join('-')}`;
}

/**
 * The server PC's updater (decisions 0108, 0115) as a Task Scheduler definition:
 * - SYSTEM, one run at a time (a run that is still downloading is never doubled);
 * - every minute, only as a fallback: the server wakes it at once (`schtasks /Run`) after the
 *   owner's "Check now" or "Install now";
 * - its security descriptor: SYSTEM and Administrators in full, and the server's own account
 *   may read and start it, nothing else (it cannot change what the task runs);
 * - on AC power only, at most 3 days, as the tasks schtasks made before.
 */
export function updaterTaskXml(launcher: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const sddl = `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;${serviceSid(SERVICES.server.name)})`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>ARTEPOOL: checks for updates, downloads them in advance and installs them at a safe time.</Description>',
    `    <SecurityDescriptor>${sddl}</SecurityDescriptor>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <TimeTrigger>',
    '      <Repetition>',
    '        <Interval>PT1M</Interval>',
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    '      <StartBoundary>2026-01-01T00:00:00</StartBoundary>',
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <UserId>S-1-5-18</UserId>',
    '      <RunLevel>HighestAvailable</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT72H</ExecutionTimeLimit>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${esc(launcher)}</Command>`,
    '      <Arguments>run updater</Arguments>',
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** Registers (or replaces) the updater task from its definition file. */
export function updaterTask(xmlFile: string): string[] {
  return ['/Create', '/TN', UPDATER_TASK, '/XML', xmlFile, '/F'];
}

/** Starts the updater now (decision 0115); allowed to the server's account by the task's rules. */
export function wakeUpdaterTask(): string[] {
  return ['/Run', '/TN', UPDATER_TASK];
}

/** The Windows things the installation does; a fake one in the tests. */
export interface Platform {
  restrictFolder(folder: string, grants?: Grant[]): Promise<void>;
  grantFolder(folder: string, grant: Grant): Promise<void>;
  /** Registers PostgreSQL as `ArtepoolDatabase` under its own account and starts it. */
  startDatabaseService(pgdata: string): Promise<void>;
  /** Registers `ArtepoolServer` / `ArtepoolBackup` (WinSW) under their own accounts. */
  registerAppService(service: 'server' | 'backup'): Promise<void>;
  startService(service: ServiceKey): Promise<void>;
  addFirewallRule(port: number): Promise<void>;
  /** The scheduled task of the server PC's updater (decision 0108); replaced if it exists. */
  registerUpdaterTask(): Promise<void>;
  /** The data folder read-only for standard accounts, and the shared enrollment folder (M6.4). */
  closeDataRoot(dataDir: string): Promise<void>;
  sharedDeviceFolder(folder: string): Promise<void>;
}

/** What an upgrade adds (M6.2 part G2). */
export interface UpgradeWindows {
  stopService(service: ServiceKey): Promise<void>;
  /** The new version's WinSW files for a service already registered. */
  refreshAppService(service: 'server' | 'backup'): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function windowsPlatform(options: {
  exec: Exec;
  programDir: string;
  pgBin: string;
  logDir: string;
  pollMs?: number;
}): Platform & UpgradeWindows {
  const { exec } = options;
  const pollMs = options.pollMs ?? 1000;
  const waitRunning = async (service: ServiceKey) => {
    const { name } = SERVICES[service];
    for (let i = 0; i < 120; i++) {
      const out = await exec('sc.exe', ['query', name]);
      if (/STATE\s*:\s*\d+\s+RUNNING/.test(out)) return;
      if (/STATE\s*:\s*\d+\s+STOPPED/.test(out) && i > 5) {
        throw new Error(`The service ${name} stopped right after starting; see its log.`);
      }
      await sleep(pollMs);
    }
    throw new Error(`The service ${name} did not start within two minutes.`);
  };
  const waitStopped = async (service: ServiceKey) => {
    const { name } = SERVICES[service];
    for (let i = 0; i < 120; i++) {
      const out = await exec('sc.exe', ['query', name]).catch((error: unknown) => String(error));
      if (/STATE\s*:\s*\d+\s+STOPPED/.test(out) || out.includes('1060')) return;
      await sleep(pollMs);
    }
    throw new Error(`The service ${name} did not stop within two minutes.`);
  };
  const configure = async (service: ServiceKey, description: string) => {
    for (const args of scConfigure(service, description)) await exec('sc.exe', args);
  };
  const description = (service: 'server' | 'backup') =>
    service === 'server'
      ? 'ARTEPOOL ERP server: the API the PCs of the shop connect to.'
      : 'ARTEPOOL ERP backups: hourly copies, Google Drive, checks.';
  /** WinSW's copy named after the service, and its settings beside it. */
  const writeWinsw = async (service: 'server' | 'backup') => {
    const { name } = SERVICES[service];
    const dir = join(options.programDir, 'winsw');
    await copyFile(join(dir, 'winsw.exe'), join(dir, `${name}.exe`));
    await writeFile(
      join(dir, `${name}.xml`),
      winswXml({
        service,
        launcher: join(options.programDir, 'artepool-svc.exe'),
        logDir: join(options.logDir, service),
        description: description(service),
      }),
    );
    return join(dir, `${name}.exe`);
  };
  return {
    async restrictFolder(folder, grants = []) {
      await exec('icacls.exe', icaclsReset(folder));
      await exec('icacls.exe', icaclsRestrict(folder, grants));
    },
    async grantFolder(folder, grant) {
      await exec('icacls.exe', icaclsGrant(folder, grant));
    },
    async startDatabaseService(pgdata) {
      await exec(join(options.pgBin, 'pg_ctl.exe'), pgCtlRegister(pgdata));
      await configure('database', 'ARTEPOOL ERP database (PostgreSQL 18, this PC only).');
      // The data folder belongs to the database service's own account.
      await exec('icacls.exe', icaclsGrant(pgdata, { service: 'database', access: 'full' }));
      await exec('sc.exe', ['start', SERVICES.database.name]);
      await waitRunning('database');
    },
    async registerAppService(service) {
      await exec(await writeWinsw(service), ['install']);
      await configure(service, description(service));
    },
    async refreshAppService(service) {
      await writeWinsw(service);
    },
    async startService(service) {
      // Already running (error 1056) is fine.
      await exec('sc.exe', ['start', SERVICES[service].name]).catch((error: unknown) => {
        if (!String(error).includes('1056')) throw error;
      });
      await waitRunning(service);
    },
    async stopService(service) {
      // Not running (1062) or not there (1060) is fine.
      await exec('sc.exe', ['stop', SERVICES[service].name]).catch((error: unknown) => {
        if (!/1062|1060/.test(String(error))) throw error;
      });
      await waitStopped(service);
    },
    async registerUpdaterTask() {
      // Task Scheduler reads its definitions as UTF-16 (with the byte order mark).
      const file = join(tmpdir(), `artepool-updater-task-${process.pid}.xml`);
      const xml = updaterTaskXml(join(options.programDir, 'artepool-svc.exe'));
      await writeFile(
        file,
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]),
      );
      try {
        await exec('schtasks.exe', updaterTask(file));
      } finally {
        await rm(file, { force: true });
      }
    },
    async closeDataRoot(dataDir) {
      await exec('icacls.exe', icaclsDataRoot(dataDir));
    },
    async sharedDeviceFolder(folder) {
      await exec('icacls.exe', icaclsSharedDevice(folder));
    },
    async addFirewallRule(port) {
      const [remove, add] = firewallRule(port);
      await exec('netsh.exe', remove!).catch(() => undefined);
      await exec('netsh.exe', add!);
    },
  };
}
