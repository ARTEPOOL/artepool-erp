/**
 * The install log (M6.2 part F): `C:\ProgramData\ARTEPOOL\logs\install\install-<time>.log`, for
 * support. Every line goes through the secret filter first: the values of the protected secrets
 * (and any other value registered with `hide`) are replaced, and anything shaped like a private
 * key, a password setting or a setup token is cut out. Nothing secret is ever written to it.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Settings whose values are secret (as the launcher gives them). */
const SECRET_SETTING =
  /^(ARTEPOOL_MASTER_KEY|ARTEPOOL_[A-Z]+_PASSWORD|PG_SUPERUSER_PASSWORD|PGPASSWORD)$/;

const PATTERNS: RegExp[] = [
  // The owner's age private key.
  /AGE-SECRET-KEY-1[0-9A-Z]{58}/g,
  // name=value or name: value for anything that looks like a password or a secret.
  /\b([A-Za-z_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|KEY)[A-Za-z_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
];

export class InstallLog {
  private readonly hidden = new Set<string>();

  constructor(
    readonly file: string | null,
    private readonly echo: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    env: NodeJS.ProcessEnv = process.env,
  ) {
    for (const [name, value] of Object.entries(env)) {
      if (SECRET_SETTING.test(name) && value) this.hide(value);
    }
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  /** A value never to be written (a generated token, a temporary password). */
  hide(value: string): void {
    if (value.length >= 4) this.hidden.add(value);
  }

  clean(text: string): string {
    let out = text;
    for (const value of this.hidden) out = out.split(value).join('[hidden]');
    out = out.replace(PATTERNS[0]!, '[hidden]');
    out = out.replace(PATTERNS[1]!, (_match, name: string) => `${name}=[hidden]`);
    return out;
  }

  line(text: string): void {
    const clean = this.clean(text);
    const stamped = `${new Date().toISOString()} ${clean}`;
    if (this.file) appendFileSync(this.file, `${stamped}\n`);
    this.echo(clean);
  }
}

/** `install-20261025-093000.log` (UTC). */
export function logFileName(prefix: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${prefix}-${stamp}.log`;
}
