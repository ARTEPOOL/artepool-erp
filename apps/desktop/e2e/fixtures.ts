/**
 * Shared pieces for the screen tests: the language and theme of each project, the texts in that
 * language (straight from the translation files), and the harness's control endpoint.
 */
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { E2E, type Pc } from './paths';

export type Lang = 'ar' | 'en';
export type Theme = 'light' | 'dark';

const localesDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'i18n', 'locales');
const cache = new Map<string, Record<string, unknown>>();

function namespace(lang: Lang, ns: string): Record<string, unknown> {
  const key = `${lang}/${ns}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      JSON.parse(readFileSync(join(localesDir, lang, `${ns}.json`), 'utf8')) as Record<
        string,
        unknown
      >,
    );
  }
  return cache.get(key)!;
}

/** `tr('ar', 'auth:signIn.title')` → the text the screen shows, with `{name}` filled in. */
export function tr(lang: Lang, key: string, values: Record<string, string | number> = {}): string {
  const [ns, path] = key.split(':') as [string, string];
  let node: unknown = namespace(lang, ns);
  for (const part of path.split('.')) node = (node as Record<string, unknown>)[part];
  if (typeof node !== 'string') throw new Error(`No text ${lang}:${key}`);
  return node.replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name] ?? `{${name}}`));
}

export interface NewUser {
  username: string;
  method?: 'pin' | 'password';
  password?: string;
  pin?: string;
  mustChange?: boolean;
  roles?: string[];
  displayNameAr?: string;
  displayNameEn?: string;
}

/** The harness's control endpoint (see harness.ts). */
export const control = {
  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${E2E.control}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`control ${path}: ${await response.text()}`);
    return (await response.json()) as T;
  },
  apiUrl: async () => (await control.call<{ api: string }>('GET', '/ready')).api,
  addUser: (user: NewUser) => control.call<{ id: string }>('POST', '/users', user),
  owner: () => control.call<{ username: string; password: string }>('GET', '/owner'),
  ownerCode: async () => (await control.call<{ code: string }>('POST', '/owner/code')).code,
  /** A staff member set to "password + 2-step code", with these recovery codes. */
  addTwoStepUser: (user: NewUser & { password: string; recoveryCodes: string[] }) =>
    control.call<{ id: string }>('POST', '/two-step-users', user),
  /** That user's current 6-digit code (never one already used). */
  codeFor: async (userId: string) =>
    (await control.call<{ code: string }>('POST', '/code', { userId })).code,
  resetOwnerTwoStep: () => control.call('POST', '/owner/reset-2fa'),
  /** A fresh server PC just installed: empty database, setup token, "setup" PC not enrolled. */
  setupServer: () => control.call('POST', '/setup-server'),
  /** The main server's encrypted off-site copy on the setup PC's USB drive, and the key file. */
  restoreCopy: () => control.call<{ name: string; keyFile: string }>('POST', '/restore-copy'),
  addDevice: (code: string, name: string) => control.call('POST', '/devices', { code, name }),
  addPosItem: (item: {
    code: string;
    nameAr: string;
    nameEn: string;
    barcode: string;
    price4dp: string;
    quantityMilli: string;
  }) => control.call<{ id: string }>('POST', '/pos-item', item),
  addCreditCustomer: (customer: {
    name: string;
    phone: string;
    creditLimitFils: string;
    overdueFils?: string;
  }) => control.call<{ id: string }>('POST', '/credit-customer', customer),
  enrollmentCode: async () =>
    (await control.call<{ code: string }>('POST', '/enrollment-code')).code,
  stuckShift: (shift: { code: string; username: string; displayName: string; floatFils: string }) =>
    control.call<{ shiftNumber: string }>('POST', '/stuck-shift', shift),
  stopServer: () => control.call('POST', '/server/stop'),
  startServer: () => control.call('POST', '/server/start'),
};

/** A name that is new for each project and run. */
export const unique = (prefix: string) =>
  `${prefix}.${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

export const test = base.extend<{
  lang: Lang;
  theme: Theme;
  /** Opens one of the PCs' screens in this project's language and theme. */
  open: (pc: Pc) => Promise<void>;
  t: (key: string, values?: Record<string, string | number>) => string;
}>({
  lang: ['ar', { option: true }],
  theme: ['light', { option: true }],
  t: async ({ lang }, use) => {
    await use((key, values) => tr(lang, key, values));
  },
  open: async ({ page, lang, theme }, use) => {
    // Like the Windows app (tauri.conf.json freezePrototype): no library may change built-ins.
    await page.addInitScript(() => Object.freeze(Object.prototype));
    await page.addInitScript(
      ([language, colour]) => {
        if (!sessionStorage.getItem('e2e-started')) {
          sessionStorage.setItem('e2e-started', '1');
          localStorage.setItem('artepool.language', language);
          localStorage.setItem('artepool.theme', colour);
        }
      },
      [lang, theme] as const,
    );
    // React key clashes mean a list can show the wrong rows: report them in the test output.
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('same key'))
        console.warn(`React key clash on ${page.url()}: ${message.text()}`);
    });
    await use(async (pc) => {
      await page.goto(`http://localhost:${E2E.pcs[pc].port}/`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    });
  },
});

export { expect };

/** Types the six digits of a code into the boxes. */
export async function typeCode(page: Page, code: string): Promise<void> {
  await page.getByRole('textbox').first().focus();
  await page.keyboard.type(code);
}

/** A screenshot for the pull request and the owner's review: e2e-screens/<project>/<name>.png */
/**
 * A barcode scanner with the cursor anywhere on the screen (not in a field): its keys, stamped
 * together as a real scan's are, then Enter, sent to whatever has the focus.
 */
export async function scanAnywhere(page: Page, code: string): Promise<void> {
  await page.evaluate((keys) => {
    const target = document.activeElement ?? document.body;
    const events = [...keys, 'Enter'].map(
      (key) => new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
    for (const event of events) target.dispatchEvent(event);
  }, code);
}

export async function snap(page: Page, name: string): Promise<void> {
  const dir = join(import.meta.dirname, '..', 'e2e-screens', base.info().project.name);
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(400); // let the rise-in animation finish
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

function fromBase32(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of text.replace(/[\s=]/g, '').toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The 6-digit code an authenticator app shows for this key now (RFC 6238, SHA-1, 30 s). */
export function authenticatorCode(key: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hash = createHmac('sha1', fromBase32(key)).update(counter).digest();
  const offset = hash[19]! & 0xf;
  const value =
    ((hash[offset]! & 0x7f) << 24) |
    (hash[offset + 1]! << 16) |
    (hash[offset + 2]! << 8) |
    hash[offset + 3]!;
  return String(value % 1_000_000).padStart(6, '0');
}

/** Opens the account menu in the top bar and picks "Lock screen" or "Sign out". */
export async function accountMenu(
  page: Page,
  t: (key: string) => string,
  action: 'lock' | 'signOut',
): Promise<void> {
  await page.getByRole('button', { name: t('settings:user.menu') }).click();
  await page.getByRole('menuitem', { name: t(`settings:user.${action}`) }).click();
}

/** Signs in as the owner on the open PC: password, then the current 2-step code. */
export async function signInAsOwner(page: Page, t: (key: string) => string): Promise<void> {
  const owner = await control.owner();
  await page.getByLabel(t('auth:signIn.username'), { exact: true }).fill(owner.username);
  await page.getByLabel(t('auth:signIn.password'), { exact: true }).fill(owner.password);
  await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();
  await expect(page.getByRole('heading', { name: t('auth:secondFactor.title') })).toBeVisible();
  await dontRememberThisPc(page, t);
  await typeCode(page, await control.ownerCode());
  await page.getByRole('button', { name: t('auth:secondFactor.confirm') }).click();
  await expect(page.getByRole('button', { name: t('settings:user.menu') })).toBeVisible();
}

/**
 * Unticks "Remember this PC" (ticked by default, decision 0077), so the tests that sign the owner
 * in keep seeing the phone code on the shared test PCs.
 */
export async function dontRememberThisPc(page: Page, t: (key: string) => string): Promise<void> {
  const box = page.getByRole('checkbox', { name: t('auth:secondFactor.remember') });
  if ((await box.count()) === 0) return; // not offered here (a POS PC)
  if (await box.isChecked()) await page.getByText(t('auth:secondFactor.remember')).click();
  await expect(box).not.toBeChecked();
}
