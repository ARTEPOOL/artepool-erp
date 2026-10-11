/**
 * M2 T4–T5: company details (decision 0030), VAT rates (0033), numbering series (0011), the
 * chart of accounts with its event links and lines of business (0018, 0035), and periods (0016).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AccountItem,
  AccountsResponse,
  CompanyProfile,
  CompanyResponse,
  LogoResponse,
  PeriodItem,
  PeriodsResponse,
  SeriesItem,
  SeriesResponse,
  VatCategoryItem,
  VatResponse,
} from '@artepool/shared/contracts';
import {
  addDevice,
  addOwner,
  addUser,
  ageRow,
  call,
  openSession,
  startTestServer,
  type TestDevice,
  type TestServer,
} from '../support/server';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
type Actor = (method: Method, url: string, body?: unknown) => ReturnType<typeof call>;

let server: TestServer;
let office: TestDevice;
let owner: Actor;
let accountant: Actor;
let cashier: Actor;

function actor(device: TestDevice, token: string): Actor {
  return (method, url, body) =>
    call(server, method, url, {
      device,
      token,
      ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }),
      ...(body !== undefined ? { body } : {}),
    });
}

async function signedIn(username: string, roles: string[]): Promise<Actor> {
  const pc = await addDevice(server, { code: `PC-${username}` });
  const id = await addUser(server, { username, roles });
  return actor(pc, (await openSession(server, { userId: id, deviceId: pc.id })).token);
}

/** The error code and details of a refused request. */
async function refusal(response: Promise<{ statusCode: number; json: <T>() => T }>) {
  const r = await response;
  const body = r.json<{ error: { code: string; details: Record<string, unknown> } }>();
  return { status: r.statusCode, code: body.error?.code, ...body.error?.details };
}

beforeAll(async () => {
  server = await startTestServer();
  office = await addDevice(server, { code: 'OFFICE-01' });
  const ownerId = await addOwner(server);
  owner = actor(
    office,
    (await openSession(server, { userId: ownerId, deviceId: office.id, method: 'password_totp' }))
      .token,
  );
  accountant = await signedIn('acc.one', ['accountant']);
  cashier = await signedIn('cash.one', ['cashier']);
});
afterAll(() => server.close());

const company = {
  legalNameAr: 'آرتي بول لحمامات السباحة',
  legalNameEn: 'ARTEPOOL Swimming Pools',
  vatRegistered: true,
  trn: '100 1234 5678 9012',
  addressAr: 'العين، أبوظبي',
  addressEn: 'Al Ain, Abu Dhabi',
  phone: '03 765 4321',
  emirate: 'abu_dhabi',
};

/** 1×1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
).toString('base64');

describe('company details (decision 0030)', () => {
  it('are read by everyone signed in, and saved by the owner only', async () => {
    expect((await cashier('GET', '/api/v1/company')).json<CompanyResponse>()).toEqual({
      company: null,
      canEdit: false,
    });
    expect(await refusal(accountant('PUT', '/api/v1/company', company))).toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    const saved = (await owner('PUT', '/api/v1/company', company)).json<CompanyProfile>();
    expect(saved).toMatchObject({ trn: '100123456789012', phone: '+97137654321', rowVersion: 1 });
    expect((await owner('GET', '/api/v1/company')).json<CompanyResponse>().canEdit).toBe(true);
  });

  it('need a valid TRN when VAT-registered, and refuse a save over someone else’s', async () => {
    expect(
      await refusal(
        owner('PUT', '/api/v1/company', { ...company, trn: '200123456789012', rowVersion: 1 }),
      ),
    ).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      issues: [{ path: ['trn'], code: 'invalid_trn' }],
    });
    await owner('PUT', '/api/v1/company', { ...company, city: 'Al Ain', rowVersion: 1 });
    expect(
      await refusal(owner('PUT', '/api/v1/company', { ...company, city: 'Dubai', rowVersion: 1 })),
    ).toMatchObject({ status: 409, code: 'STALE_VERSION' });
  });

  it('take a PNG or JPEG logo only, recognised by its content, and never log its bytes', async () => {
    const version = (await owner('GET', '/api/v1/company')).json<CompanyResponse>().company!
      .rowVersion;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>').toString(
      'base64',
    );
    expect(
      await refusal(
        owner('PUT', '/api/v1/company/logo', {
          logo: { type: 'image/png', dataBase64: svg },
          rowVersion: version,
        }),
      ),
    ).toMatchObject({ status: 422, code: 'RULE_VIOLATION', rule: 'LOGO_INVALID' });
    const saved = (
      await owner('PUT', '/api/v1/company/logo', {
        logo: { type: 'image/png', dataBase64: PNG },
        rowVersion: version,
      })
    ).json<CompanyProfile>();
    expect(saved.logoType).toBe('image/png');
    expect((await cashier('GET', '/api/v1/company/logo')).json<LogoResponse>()).toEqual({
      logo: { type: 'image/png', dataBase64: PNG },
    });
    const { rows } = await server.admin.query<{ new_values: { logo: string } }>(
      `SELECT new_values FROM audit.log WHERE entity_type = 'sys.company_profile' AND new_values ->> 'logo' IS NOT NULL`,
    );
    expect(rows.map((r) => r.new_values.logo)).toEqual(['[redacted]']);
  });
});

describe('VAT rates (decision 0033)', () => {
  const standard = async () =>
    (await cashier('GET', '/api/v1/settings/vat'))
      .json<VatResponse>()
      .categories.find((c) => c.code === 'SR')!;

  it('are visible to everyone, with the e-invoicing date still waiting for the accountant', async () => {
    const vat = (await cashier('GET', '/api/v1/settings/vat')).json<VatResponse>();
    expect(vat.categories.map((c) => [c.code, c.rateBp])).toEqual([
      ['SR', 500],
      ['ZR', 0],
      ['EX', 0],
      ['OS', 0],
    ]);
    expect(vat.einvoiceMandatoryFrom).toBeNull();
  });

  it('change only by the owner, with a reason', async () => {
    const sr = await standard();
    expect(
      await refusal(
        accountant('PATCH', `/api/v1/settings/vat/${sr.id}`, {
          rateBp: 600,
          reason: 'New law',
          rowVersion: sr.rowVersion,
        }),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await refusal(
        owner('PATCH', `/api/v1/settings/vat/${sr.id}`, { rateBp: 600, rowVersion: sr.rowVersion }),
      ),
    ).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    const changed = (
      await owner('PATCH', `/api/v1/settings/vat/${sr.id}`, {
        rateBp: 600,
        reason: 'Test of a new law',
        rowVersion: sr.rowVersion,
      })
    ).json<VatCategoryItem>();
    expect(changed.rateBp).toBe(600);
    expect(
      await refusal(
        owner('PATCH', `/api/v1/settings/vat/${sr.id}`, {
          rateBp: 0,
          reason: 'Never',
          rowVersion: changed.rowVersion,
        }),
      ),
    ).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    await owner('PATCH', `/api/v1/settings/vat/${sr.id}`, {
      rateBp: 500,
      reason: 'Back to 5%',
      rowVersion: changed.rowVersion,
    });
    expect((await standard()).rateBp).toBe(500);
  });
});

describe('numbering series (decision 0011)', () => {
  it('are shown to the owner, and their prefix changes only until the first number', async () => {
    expect((await accountant('GET', '/api/v1/settings/series')).statusCode).toBe(403);
    const list = (await owner('GET', '/api/v1/settings/series')).json<SeriesResponse>().series;
    const quotation = list.find((s) => s.code === 'Q')!;
    expect(quotation).toMatchObject({ prefix: 'Q-', used: false, nextFormatted: 'Q-000001' });
    const changed = (
      await owner('PATCH', `/api/v1/settings/series/${quotation.id}`, {
        prefix: 'quo-',
        numberWidth: 5,
        startNumber: '1',
        rowVersion: quotation.rowVersion,
      })
    ).json<SeriesItem>();
    expect(changed).toMatchObject({ prefix: 'QUO-', nextFormatted: 'QUO-00001' });
  });
});

describe('the chart of accounts (decisions 0018, 0035)', () => {
  const chart = async () => (await accountant('GET', '/api/v1/accounts')).json<AccountsResponse>();
  const byCode = async (code: string) => (await chart()).accounts.find((a) => a.code === code)!;

  it('is read with ledger.view and changed with accounts.manage', async () => {
    expect((await cashier('GET', '/api/v1/accounts')).statusCode).toBe(403);
    const { accounts, links } = await chart();
    expect(accounts).toHaveLength(75);
    expect(links).toHaveLength(12);
    expect(accounts.find((a) => a.code === '1210')).toMatchObject({
      isControl: true,
      inUse: 'event_link',
    });
    expect(accounts.find((a) => a.code === '4100')!.inUse).toBe('business_line');
  });

  it('adds accounts under headers only, and explains why an account cannot change', async () => {
    const pettyExpenses = await byCode('6900');
    expect(
      await refusal(
        accountant('POST', '/api/v1/accounts', {
          code: '6901',
          nameAr: 'ضيافة',
          nameEn: 'Hospitality',
          accountType: 'expense',
          parentId: pettyExpenses.id,
          isPostable: true,
        }),
      ),
    ).toMatchObject({ status: 422, code: 'RULE_VIOLATION', rule: 'ACCOUNT_PARENT_NOT_HEADER' });
    const created = (
      await accountant('POST', '/api/v1/accounts', {
        code: '6150',
        nameAr: 'ضيافة',
        nameEn: 'Hospitality',
        accountType: 'expense',
        parentId: (await byCode('6000')).id,
        isPostable: true,
      })
    ).json<AccountItem>();
    expect(created).toMatchObject({ code: '6150', inUse: null, rowVersion: 1 });
    expect(
      await refusal(
        accountant('POST', '/api/v1/accounts', {
          code: '6150',
          nameAr: 'س',
          nameEn: 'X',
          accountType: 'expense',
          parentId: (await byCode('6000')).id,
          isPostable: true,
        }),
      ),
    ).toMatchObject({ status: 409, code: 'DUPLICATE', field: 'code' });
    const shortOver = await byCode('6910');
    expect(
      await refusal(
        accountant('POST', `/api/v1/accounts/${shortOver.id}/deactivate`, {
          reason: 'Not needed',
          rowVersion: shortOver.rowVersion,
        }),
      ),
    ).toMatchObject({ code: 'RULE_VIOLATION', rule: 'ACCOUNT_IN_USE', why: 'event_link' });
    const deactivated = (
      await accountant('POST', `/api/v1/accounts/${created.id}/deactivate`, {
        reason: 'Opened by mistake',
        rowVersion: 1,
      })
    ).json<AccountItem>();
    expect(deactivated.isActive).toBe(false);
    expect(
      await refusal(
        accountant('POST', `/api/v1/accounts/${created.id}/reactivate`, { rowVersion: 1 }),
      ),
    ).toMatchObject({ status: 409, code: 'STALE_VERSION' });
  });

  it('links events only to suitable accounts', async () => {
    const link = (await chart()).links.find((l) => l.key === 'cash_over_short')!;
    expect(
      await refusal(
        accountant('PATCH', '/api/v1/account-links/cash_over_short', {
          accountId: (await byCode('6000')).id,
          rowVersion: link.rowVersion,
        }),
      ),
    ).toMatchObject({ code: 'RULE_VIOLATION', rule: 'MAPPING_ACCOUNT_INVALID' });
    const moved = await accountant('PATCH', '/api/v1/account-links/cash_over_short', {
      accountId: (await byCode('6990')).id,
      rowVersion: link.rowVersion,
    });
    expect(moved.statusCode).toBe(200);
    expect((await byCode('6990')).inUse).toBe('event_link');
    expect((await byCode('6910')).inUse).toBeNull();
    expect(
      (
        await cashier('PATCH', '/api/v1/account-links/cash_over_short', {
          accountId: '1',
          rowVersion: 1,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('lists the lines of business for everyone signed in', async () => {
    const { businessLines } = (await cashier('GET', '/api/v1/business-lines')).json<{
      businessLines: { code: string }[];
    }>();
    expect(businessLines.map((b) => b.code)).toEqual([
      'supplies',
      'construction',
      'maintenance',
      'cleaning',
    ]);
  });
});

describe('periods (decisions 0016, 0035)', () => {
  const periods = async () => (await accountant('GET', '/api/v1/periods')).json<PeriodsResponse>();
  const month = async (start: string): Promise<PeriodItem> =>
    (await periods()).periods.find((p) => p.periodStart === start)!;

  beforeAll(async () => {
    // Ended months in 2020, so the steps below never depend on today's date.
    await ageRow(
      server,
      `INSERT INTO gl.periods (period_start, period_end, fiscal_year, created_by, updated_by)
       SELECT d::date, (d + interval '1 month' - interval '1 day')::date, 2020, 1, 1
         FROM generate_series('2020-01-01'::date, '2020-02-01'::date, interval '1 month') AS d`,
      [],
    );
  });

  it('close and lock in order, reopen with a reason, and a locked month is final', async () => {
    const january = await month('2020-01-01');
    expect(
      await refusal(
        cashier('POST', `/api/v1/periods/${january.id}/close`, { rowVersion: january.rowVersion }),
      ),
    ).toMatchObject({ status: 403 });
    const closed = (
      await accountant('POST', `/api/v1/periods/${january.id}/close`, {
        rowVersion: january.rowVersion,
      })
    ).json<PeriodItem>();
    expect(closed).toMatchObject({ status: 'closed', closedByName: 'User' });
    expect(
      await refusal(
        accountant('POST', `/api/v1/periods/${january.id}/reopen`, {
          rowVersion: closed.rowVersion,
        }),
      ),
    ).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    const reopened = (
      await accountant('POST', `/api/v1/periods/${january.id}/reopen`, {
        reason: 'Missed invoice',
        rowVersion: closed.rowVersion,
      })
    ).json<PeriodItem>();
    expect(reopened.status).toBe('open');
    const again = (
      await accountant('POST', `/api/v1/periods/${january.id}/close`, {
        rowVersion: reopened.rowVersion,
      })
    ).json<PeriodItem>();
    const locked = (
      await accountant('POST', `/api/v1/periods/${january.id}/lock`, {
        rowVersion: again.rowVersion,
      })
    ).json<PeriodItem>();
    expect(locked.status).toBe('locked');
    expect(
      await refusal(
        accountant('POST', `/api/v1/periods/${january.id}/reopen`, {
          reason: 'Oops',
          rowVersion: locked.rowVersion,
        }),
      ),
    ).toMatchObject({ code: 'RULE_VIOLATION', rule: 'PERIOD_LOCKED' });
    const { today, periods: all } = await periods();
    const current = all.find((p) => p.periodStart <= today && p.periodEnd >= today)!;
    expect(
      await refusal(
        accountant('POST', `/api/v1/periods/${current.id}/close`, {
          rowVersion: current.rowVersion,
        }),
      ),
    ).toMatchObject({ code: 'RULE_VIOLATION', rule: 'PERIOD_NOT_ENDED' });
  });
});
