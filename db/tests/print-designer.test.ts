/**
 * Migration 0023: the print designer. UAE IBANs are checked with their checksum; only the owner
 * writes the company's bank accounts, never deletes them and deactivates them with a reason
 * (0065); a template's current version is one of its own and only the owner changes it (0020);
 * the thermal receipt's language now lives in its template (0064).
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDevice,
  createTestDatabase,
  createUser,
  setContext,
  type TestDatabase,
} from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;
let owner: bigint;
let accountant: bigint;
let device: bigint;

const rule = (hint: string) => ({ code: 'AP011', hint });
const denied = (hint: string) => ({ code: 'AP012', hint });
const VALID = 'AE070331234567890123456';

async function tx<T>(
  work: (c: pg.Client) => Promise<T>,
  userId: bigint = owner,
  reason: string | null = null,
): Promise<T> {
  await api.query('BEGIN');
  try {
    await setContext(api, userId, reason, device);
    const result = await work(api);
    await api.query('COMMIT');
    return result;
  } catch (error) {
    await api.query('ROLLBACK');
    throw error;
  }
}

const addAccount = (c: pg.Client, iban: string, swift: string | null = null) =>
  c
    .query<{ id: string }>(
      `INSERT INTO sys.company_bank_accounts (bank_name, account_name, iban, swift)
       VALUES ('Emirates NBD', 'ARTEPOOL Swimming Pools', $1, $2) RETURNING id`,
      [iban, swift],
    )
    .then((r) => r.rows[0]!.id);

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  owner = await createUser(api, {
    username: 'owner.print',
    roles: ['owner'],
    signInMethod: 'password_totp',
  });
  accountant = await createUser(api, { username: 'acc.print', roles: ['accountant'] });
  device = await createDevice(api, { code: 'OFFICE-PRINT' });
});
afterAll(() => db.drop());

describe('UAE IBAN (0065)', () => {
  it('AE + 21 digits with the mod-97 checksum', async () => {
    const check = async (iban: string) =>
      (await api.query<{ ok: boolean }>(`SELECT sys.valid_uae_iban($1) AS ok`, [iban])).rows[0]!.ok;
    expect(await check(VALID)).toBe(true);
    expect(await check('AE070331234567890123457')).toBe(false); // checksum
    expect(await check('AE07033123456789012345')).toBe(false); // too short
    expect(await check('GB82WEST12345698765432')).toBe(false); // not the UAE
    expect(await check('ae070331234567890123456')).toBe(false); // saved upper case, no spaces
  });
});

describe('company bank accounts (0065)', () => {
  it('only the owner writes them; a wrong IBAN or SWIFT is refused; never deleted', async () => {
    await expect(tx((c) => addAccount(c, VALID), accountant)).rejects.toMatchObject(
      denied('COMPANY_OWNER_ONLY'),
    );
    await expect(tx((c) => addAccount(c, 'AE070331234567890123457'))).rejects.toMatchObject({
      code: '23514',
    });
    await expect(tx((c) => addAccount(c, VALID, 'EBIL'))).rejects.toMatchObject({
      code: '23514',
    });
    const id = await tx((c) => addAccount(c, VALID, 'EBILAEAD'));
    // The same IBAN twice while active is refused.
    await expect(tx((c) => addAccount(c, VALID))).rejects.toMatchObject({ code: '23505' });
    await expect(
      tx((c) => c.query(`DELETE FROM sys.company_bank_accounts WHERE id = $1`, [id])),
    ).rejects.toBeTruthy();
    await expect(
      tx((c) =>
        c.query(`UPDATE sys.company_bank_accounts SET is_active = false WHERE id = $1`, [id]),
      ),
    ).rejects.toBeTruthy();
    await tx(
      (c) => c.query(`UPDATE sys.company_bank_accounts SET is_active = false WHERE id = $1`, [id]),
      owner,
      'Account closed',
    );
    const audit = await api.query(
      `SELECT 1 FROM audit.log WHERE entity_type = 'sys.company_bank_accounts' AND entity_id = $1`,
      [id],
    );
    expect(audit.rowCount).toBe(2);
  });
});

describe('print templates (0020, 0064)', () => {
  it('the current version is one of the template’s own, changed by the owner only', async () => {
    const t = (
      await api.query<{ invoice: string; quotation: string; qversion: string }>(
        `SELECT (SELECT id::text FROM sys.print_templates WHERE doc_kind = 'tax_invoice_a4') AS invoice,
                (SELECT id::text FROM sys.print_templates WHERE doc_kind = 'quotation_a4') AS quotation,
                (SELECT current_version_id::text FROM sys.print_templates WHERE doc_kind = 'quotation_a4') AS qversion`,
      )
    ).rows[0]!;
    await expect(
      tx((c) =>
        c.query(`UPDATE sys.print_templates SET current_version_id = $1 WHERE id = $2`, [
          t.qversion,
          t.invoice,
        ]),
      ),
    ).rejects.toMatchObject(rule('PRINT_VERSION'));
    const version = await tx(async (c) => {
      const v = await c.query<{ id: string }>(
        `INSERT INTO sys.print_template_versions (template_id, settings) VALUES ($1, '{"language":"ar"}')
         RETURNING id`,
        [t.invoice],
      );
      return v.rows[0]!.id;
    });
    await expect(
      tx(
        (c) =>
          c.query(`UPDATE sys.print_templates SET current_version_id = $1 WHERE id = $2`, [
            version,
            t.invoice,
          ]),
        accountant,
      ),
    ).rejects.toMatchObject(denied('PRINT_OWNER_ONLY'));
    await tx((c) =>
      c.query(`UPDATE sys.print_templates SET current_version_id = $1 WHERE id = $2`, [
        version,
        t.invoice,
      ]),
    );
  });

  it('the thermal receipt’s language moved from the old setting into its template', async () => {
    const r = (
      await api.query<{ language: string; versions: number }>(
        `SELECT v.settings ->> 'language' AS language,
                (SELECT count(*)::int FROM sys.print_template_versions WHERE template_id = t.id) AS versions
           FROM sys.print_templates t JOIN sys.print_template_versions v ON v.id = t.current_version_id
          WHERE t.doc_kind = 'receipt_thermal'`,
      )
    ).rows[0]!;
    expect(r).toEqual({ language: 'both', versions: 2 });
  });
});
