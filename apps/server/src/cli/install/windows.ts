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
import { copyFile, writeFile } from 'node:fs/promises';
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
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function windowsPlatform(options: {
  exec: Exec;
  programDir: string;
  pgBin: string;
  logDir: string;
  pollMs?: number;
}): Platform {
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
  const configure = async (service: ServiceKey, description: string) => {
    for (const args of scConfigure(service, description)) await exec('sc.exe', args);
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
      const { name } = SERVICES[service];
      const dir = join(options.programDir, 'winsw');
      const description =
        service === 'server'
          ? 'ARTEPOOL ERP server: the API the PCs of the shop connect to.'
          : 'ARTEPOOL ERP backups: hourly copies, Google Drive, checks.';
      await copyFile(join(dir, 'winsw.exe'), join(dir, `${name}.exe`));
      await writeFile(
        join(dir, `${name}.xml`),
        winswXml({
          service,
          launcher: join(options.programDir, 'artepool-svc.exe'),
          logDir: join(options.logDir, service),
          description,
        }),
      );
      await exec(join(dir, `${name}.exe`), ['install']);
      await configure(service, description);
    },
    async startService(service) {
      await exec('sc.exe', ['start', SERVICES[service].name]);
      await waitRunning(service);
    },
    async addFirewallRule(port) {
      const [remove, add] = firewallRule(port);
      await exec('netsh.exe', remove!).catch(() => undefined);
      await exec('netsh.exe', add!);
    },
  };
}
