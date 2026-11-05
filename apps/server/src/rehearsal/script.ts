/**
 * The scripted day of the rehearsal (M7, decision 0119; phase plan §6.3), played through the
 * server's real API by the people and PCs of a small shop:
 * - the owner, the accountant and the storekeeper on office PCs;
 * - the cashiers on the POS PCs, all tills selling at the same time while the A4 work goes on;
 * - every case of the day: discounts within and above the limit, cart removals, an oversell
 *   with approval and its review, returns to sellable and to defective, quotation → advance →
 *   progress payment → final invoice with deductions for a VAT-registered customer, credit
 *   sales and receipts, a bounced cheque, credit and debit notes, paid-in/out, a cash drop, an
 *   X report, a stock count with variances, label prints, every document printed, shift closes
 *   with one approved recount, and the variance accepted.
 * The same script makes the CI busy day (four tills, 800+ sales, 20,000 items).
 */
import { sql } from 'kysely';
import { computeLine, lineAmountFils, roundDiv } from '@artepool/shared';
import { newTotpSecret } from '../platform/auth/totp';
import { RehearsalError, type Actor, type Pc, type RehearsalServer } from './harness';
import { isPdf, pdfHasText } from './pdf';

export interface RehearsalSize {
  name: 'shop' | 'busy';
  tills: number;
  salesPerTill: number;
  items: number;
}
/** Every case on two tills and an office PC: about 150 POS sales. */
export const SHOP_DAY: RehearsalSize = { name: 'shop', tills: 2, salesPerTill: 75, items: 300 };
/** The CI busy day: four tills at once, 800+ POS sales, 20,000 items (PRD §12). */
export const BUSY_DAY: RehearsalSize = { name: 'busy', tills: 4, salesPerTill: 210, items: 20_000 };

export const SCRIPT_STEPS = [
  'pcs_and_people',
  'company_and_items',
  'customers',
  'shifts_open',
  'the_day',
  'returns',
  'cash_movements',
  'stock',
  'labels',
  'oversell_review',
  'printing',
  'shifts_close',
] as const;
export type ScriptStep = (typeof SCRIPT_STEPS)[number];

export interface StepOutcome {
  step: string;
  ok: boolean;
  ms: number;
  detail?: string;
}
export type Progress = (outcome: StepOutcome) => void | Promise<void>;

const PASSWORD = 'Rehearsal-Pool-Water-2026';
const PINS = ['4829', '5837', '6941', '7253'];
const FLOAT = 50_000n;
const STANDARD_BP = 500n;

/** A small deterministic random sequence: every rehearsal plays the same day. */
function prng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s % n;
  };
}

/** EAN-13 with the GS1 UAE prefix 629 and its check digit. */
function ean13(n: number): string {
  const body = `629${String(n).padStart(9, '0')}`;
  const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

interface Item {
  id: string;
  name: string;
  barcode: string;
  price4dp: bigint;
  includesVat: boolean;
  /** The item's VAT rate: 5% standard, 0 for zero-rated and exempt (decision 0033). */
  rateBp: bigint;
}
interface SaleLine {
  item: Item;
  quantityMilli: bigint;
  discountBp?: number;
}

/** What the sale costs, exactly as the server works it out (decisions 0009, 0012). */
function saleTotal(lines: SaleLine[]): bigint {
  return lines.reduce((sum, l) => {
    const amount = lineAmountFils(l.quantityMilli, l.item.price4dp);
    const discount = l.discountBp ? roundDiv(amount * BigInt(l.discountBp), 10_000n) : 0n;
    return (
      sum +
      computeLine({
        quantity: l.quantityMilli,
        unitPrice4dp: l.item.price4dp,
        pricesIncludeVat: l.item.includesVat,
        vatRateBp: l.item.rateBp,
        lineDiscountFils: discount,
      }).grossFils
    );
  }, 0n);
}

const body = (lines: SaleLine[]) =>
  lines.map((l) => ({
    itemId: l.item.id,
    quantityMilli: l.quantityMilli.toString(),
    ...(l.discountBp ? { lineDiscountBp: l.discountBp } : {}),
  }));

interface Ref {
  category: string;
  service: string;
  pcs: string;
  kg: string;
  visit: string;
  vat: string;
  zeroRated: string;
  exempt: string;
  construction: string;
  cash: string;
  card: string;
  bank: string;
  cheque: string;
  note100: string;
  opening: string;
  cnReturn: string;
  dnPrice: string;
  petty: string;
  changeFloat: string;
  bounced: string;
  found: string;
  damaged: string;
  loss: string;
  labelSize: string;
}

async function referenceData(server: RehearsalServer): Promise<Ref> {
  const { rows } = await sql<{ k: string; id: string }>`
    SELECT 'category' AS k, id::text FROM md.item_categories WHERE code = 'CHEM'
    UNION ALL SELECT 'service', id::text FROM md.item_categories WHERE code = 'SERV'
    UNION ALL SELECT 'pcs', id::text FROM md.units WHERE code = 'PCS'
    UNION ALL SELECT 'kg', id::text FROM md.units WHERE code = 'KG'
    UNION ALL SELECT 'visit', id::text FROM md.units WHERE code = 'VISIT'
    UNION ALL SELECT 'vat', id::text FROM md.vat_categories WHERE code = 'SR'
    UNION ALL SELECT 'zeroRated', id::text FROM md.vat_categories WHERE code = 'ZR'
    UNION ALL SELECT 'exempt', id::text FROM md.vat_categories WHERE code = 'EX'
    UNION ALL SELECT 'construction', id::text FROM md.business_lines WHERE code = 'construction'
    UNION ALL SELECT lower(code), id::text FROM md.payment_methods WHERE code IN ('CASH', 'CARD', 'BANK', 'CHEQUE')
    UNION ALL SELECT 'note100', id::text FROM md.cash_denominations WHERE value_fils = 10000
    UNION ALL SELECT 'opening', id::text FROM sys.reason_codes WHERE category = 'other' AND code = 'OPENING'
    UNION ALL SELECT 'cnReturn', id::text FROM sys.reason_codes WHERE category = 'credit_note' AND code = 'RETURN'
    UNION ALL SELECT 'dnPrice', id::text FROM sys.reason_codes WHERE category = 'debit_note' AND code = 'PRICE_ADJ'
    UNION ALL SELECT 'petty', id::text FROM sys.reason_codes WHERE category = 'paid_out' AND code = 'PETTY'
    UNION ALL SELECT 'changeFloat', id::text FROM sys.reason_codes WHERE category = 'paid_in' AND code = 'CHANGE_FLOAT'
    UNION ALL SELECT 'bounced', id::text FROM sys.reason_codes WHERE category = 'payment_reversal' AND code = 'BOUNCED'
    UNION ALL SELECT 'found', id::text FROM sys.reason_codes WHERE category = 'stock_increase' AND code = 'FOUND'
    UNION ALL SELECT 'damaged', id::text FROM sys.reason_codes WHERE category = 'stock_decrease' AND code = 'DAMAGED'
    UNION ALL SELECT 'loss', id::text FROM sys.reason_codes WHERE category = 'stock_count' AND code = 'LOSS'
    UNION ALL SELECT 'labelSize', id::text FROM md.label_sizes WHERE code = '50X30'`.execute(
    server.db,
  );
  const ref: Record<string, string> = {};
  for (const r of rows) ref[r.k] ??= r.id;
  const needed: (keyof Ref)[] = [
    'category',
    'service',
    'pcs',
    'kg',
    'visit',
    'vat',
    'zeroRated',
    'exempt',
    'construction',
    'cash',
    'card',
    'bank',
    'cheque',
    'note100',
    'opening',
    'cnReturn',
    'dnPrice',
    'petty',
    'changeFloat',
    'bounced',
    'found',
    'damaged',
    'loss',
    'labelSize',
  ];
  const missing = needed.filter((k) => !ref[k]);
  if (missing.length > 0) throw new RehearsalError(`Reference data missing: ${missing.join(', ')}`);
  return ref as unknown as Ref;
}

interface Till {
  pc: Pc;
  cashier: Actor;
  shiftId: string;
  sales: { id: string; lines: { id: string }[]; method: 'cash' | 'card' | 'split' }[];
}

/** The day itself. `progress` hears each step as it ends; a failed step stops the script. */
export async function runScriptedDay(
  server: RehearsalServer,
  size: RehearsalSize,
  progress: Progress,
): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  const step = async <T>(name: ScriptStep, work: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      const value = await work();
      const outcome = { step: name, ok: true, ms: Date.now() - started };
      outcomes.push(outcome);
      await progress(outcome);
      return value;
    } catch (error) {
      const outcome = {
        step: name,
        ok: false,
        ms: Date.now() - started,
        detail: error instanceof Error ? error.message : String(error),
      };
      outcomes.push(outcome);
      await progress(outcome);
      throw new StopScript(outcome);
    }
  };
  const random = prng(20_261_105);

  try {
    // ---- The PCs and the people ----------------------------------------------------------------
    const people = await step('pcs_and_people', async () => {
      const secrets = {
        owner: newTotpSecret(),
        accountant: newTotpSecret(),
        supervisor: newTotpSecret(),
      };
      const ownerId = await server.staff({
        username: 'rehearsal.owner',
        role: 'owner',
        password: PASSWORD,
        totpSecret: secrets.owner,
      });
      const accountantId = await server.staff({
        username: 'rehearsal.accountant',
        role: 'accountant',
        password: PASSWORD,
        totpSecret: secrets.accountant,
      });
      const supervisorId = await server.staff({
        username: 'rehearsal.supervisor',
        role: 'accountant',
        password: PASSWORD,
        totpSecret: secrets.supervisor,
      });
      await server.staff({
        username: 'rehearsal.storekeeper',
        role: 'storekeeper',
        password: PASSWORD,
      });
      server.addApprover(ownerId, secrets.owner);
      server.addApprover(accountantId, secrets.accountant);
      server.addApprover(supervisorId, secrets.supervisor);

      // The first PC with a code from the server console, the others with codes from the owner.
      const office1 = await server.enroll(await server.consoleCode(), 'REH-OFFICE-1', 'office');
      const owner = await server.signIn(office1, 'rehearsal.owner', PASSWORD, secrets.owner);
      const code = async () =>
        ((await owner('POST', '/api/v1/devices/enrollment-codes')) as { code: string }).code;
      const office2 = await server.enroll(await code(), 'REH-OFFICE-2', 'office');
      const accountant = await server.signIn(
        office2,
        'rehearsal.accountant',
        PASSWORD,
        secrets.accountant,
      );
      const office3 = await server.enroll(await code(), 'REH-OFFICE-3', 'office');
      const storekeeper = await server.signIn(office3, 'rehearsal.storekeeper', PASSWORD);
      const tills: Till[] = [];
      for (let t = 0; t < size.tills; t++) {
        const pc = await server.enroll(await code(), `REH-POS-${t + 1}`, 'pos');
        const username = `rehearsal.cashier${t + 1}`;
        const id = await server.staff({ username, role: 'cashier', pin: PINS[t % PINS.length]! });
        const cashier = await server.signInPin(pc, id, username, PINS[t % PINS.length]!);
        tills.push({ pc, cashier, shiftId: '', sales: [] });
      }
      return { owner, accountant, storekeeper, tills };
    });
    const { owner, accountant, storekeeper, tills } = people;
    const ref = await referenceData(server);

    // ---- The company and the items -------------------------------------------------------------
    const catalogue = await step('company_and_items', async () => {
      const current = (await owner('GET', '/api/v1/company')) as {
        company: { rowVersion: number } | null;
      };
      await owner('PUT', '/api/v1/company', {
        legalNameAr: 'آرتيبول لحمامات السباحة (بروفة)',
        legalNameEn: 'ARTEPOOL Swimming Pools (rehearsal)',
        vatRegistered: true,
        trn: '100123456789012',
        addressAr: 'العين، أبوظبي',
        addressEn: 'Al Ain, Abu Dhabi',
        ...(current.company ? { rowVersion: current.company.rowVersion } : {}),
      });
      const list: Item[] = [];
      for (let i = 1; i <= size.items; i++) {
        const includesVat = i % 2 === 0;
        const price4dp = BigInt(5 + (i % 200)) * 10_000n + 2_500n;
        const barcode = ean13(i);
        const created = (await owner('POST', '/api/v1/items', {
          code: `R${String(i).padStart(5, '0')}`,
          itemType: 'stock',
          nameAr: `صنف البروفة ${i}`,
          nameEn: `Rehearsal item ${i}`,
          categoryId: ref.category,
          unitId: ref.pcs,
          vatCategoryId: ref.vat,
          price: { price4dp: price4dp.toString(), includesVat },
          barcodes: [{ barcode }],
        })) as { id: string };
        list.push({
          id: created.id,
          name: `Rehearsal item ${i}`,
          barcode,
          price4dp,
          includesVat,
          rateBp: STANDARD_BP,
        });
      }
      // Opening stock, once, by the owner (0042): 100 of each, at 60% of the price.
      for (let from = 0; from < list.length; from += 500) {
        await owner('POST', '/api/v1/stock/adjustments', {
          kind: 'opening',
          reasonCodeId: ref.opening,
          lines: list.slice(from, from + 500).map((it) => ({
            itemId: it.id,
            quantityMilli: '100000',
            unitCost4dp: ((it.price4dp * 6n) / 10n).toString(),
          })),
        });
      }
      // One of each other kind: sold by the kilo (with its quantity typed in the item window,
      // decision 0053), a service visit, zero-rated, exempt, and a kit made of two stock items.
      const other = async (
        n: number,
        fields: Record<string, unknown>,
        price4dp: bigint,
        includesVat: boolean,
        rateBp: bigint,
      ): Promise<Item> => {
        const barcode = ean13(900_000 + n);
        const created = (await owner('POST', '/api/v1/items', {
          code: `RX${n}`,
          nameAr: `صنف خاص ${n}`,
          nameEn: `Special item ${n}`,
          categoryId: ref.category,
          unitId: ref.pcs,
          vatCategoryId: ref.vat,
          price: { price4dp: price4dp.toString(), includesVat },
          barcodes: [{ barcode }],
          ...fields,
        })) as { id: string };
        return {
          id: created.id,
          name: `Special item ${n}`,
          barcode,
          price4dp,
          includesVat,
          rateBp,
        };
      };
      const specials = [
        await other(
          1,
          {
            itemType: 'stock',
            unitId: ref.kg,
            openingStock: { quantityMilli: '50000', unitCost4dp: '80000' },
          },
          125_000n,
          false,
          STANDARD_BP,
        ),
        await other(
          2,
          { itemType: 'service', categoryId: ref.service, unitId: ref.visit },
          1_500_000n,
          true,
          STANDARD_BP,
        ),
        await other(
          3,
          {
            itemType: 'stock',
            vatCategoryId: ref.zeroRated,
            purchaseCost4dp: '60000',
            openingStock: { quantityMilli: '100000' },
          },
          99_900n,
          false,
          0n,
        ),
        await other(
          4,
          {
            itemType: 'stock',
            vatCategoryId: ref.exempt,
            purchaseCost4dp: '30000',
            openingStock: { quantityMilli: '100000' },
          },
          45_000n,
          true,
          0n,
        ),
        await other(
          5,
          {
            itemType: 'bundle',
            components: [
              { itemId: list[0]!.id, quantityMilli: '2000' },
              { itemId: list[1]!.id, quantityMilli: '1000' },
            ],
          },
          250_000n,
          true,
          STANDARD_BP,
        ),
      ];
      return { list, specials };
    });
    const items = catalogue.list;
    // The item that runs out (an oversell) has a single piece.
    const scarce = items[items.length - 1]!;
    await owner('POST', '/api/v1/stock/adjustments', {
      kind: 'decrease',
      reasonCodeId: ref.damaged,
      lines: [{ itemId: scarce.id, quantityMilli: '99000' }],
    });

    // ---- Customers -----------------------------------------------------------------------------
    const customers = await step('customers', async () => {
      const company = (await owner('POST', '/api/v1/customers', {
        customerType: 'company',
        name: 'Rehearsal Pools LLC',
        phone: '050 700 0001',
        isVatRegistered: true,
        trn: '100987654321003',
        addressLine: 'Sanaiya, Al Ain',
      })) as { id: string; rowVersion: number };
      await owner('POST', `/api/v1/customers/${company.id}/credit`, {
        credit: { mode: 'credit', creditLimitFils: '50000000', paymentTermsDays: 30 },
        reason: 'Rehearsal: a known contractor',
        rowVersion: company.rowVersion,
      });
      const villa = (await owner('POST', '/api/v1/customers', {
        customerType: 'individual',
        name: 'Rehearsal Villa',
        phone: '050 700 0002',
        isVatRegistered: false,
        addressLine: 'Al Jimi, Al Ain',
      })) as { id: string };
      return { company: company.id, villa: villa.id };
    });

    // ---- Shifts open ---------------------------------------------------------------------------
    await step('shifts_open', async () => {
      for (const till of tills) {
        const shift = (await till.cashier('POST', '/api/v1/shifts', {
          openingFloatFils: FLOAT.toString(),
        })) as { id: string };
        till.shiftId = shift.id;
      }
    });

    // ---- The day: every till selling at once, and the A4 work at the same time ------------------
    let oversellNumber: string | null = null;
    const a4: Record<string, string> = {};
    await step('the_day', async () => {
      const sell = async (till: Till, t: number) => {
        for (let s = 0; s < size.salesPerTill; s++) {
          const n = 1 + random(3);
          const lines: SaleLine[] = [];
          for (let k = 0; k < n; k++) {
            const item = items[random(items.length - 1)]!;
            if (lines.some((l) => l.item.id === item.id)) continue;
            lines.push({ item, quantityMilli: BigInt(1 + random(3)) * 1000n });
          }
          // Looking the items up first: a search by name and a scan, as the cashier does.
          await till.cashier(
            'GET',
            `/api/v1/items?q=${encodeURIComponent(lines[0]!.item.name)}&status=active&pageSize=48`,
          );
          await till.cashier(
            'GET',
            `/api/v1/items?q=${lines[0]!.item.barcode}&status=active&pageSize=48`,
          );
          const extra: Record<string, unknown> = {};
          if (s % 10 === 3) lines[0]!.discountBp = 300; // within the cashier's 5%
          if (s % 25 === 7) {
            lines[0]!.discountBp = 1000; // above it: a supervisor approves
            extra.approvalId = await server.approval(till.cashier, 'sales.discount_over_limit');
          }
          if (s % 30 === 11) {
            extra.removals = [
              { itemId: items[0]!.id, quantityMilli: '1000', removedAt: new Date().toISOString() },
            ];
          }
          if (s % 40 === 19 && t === 0) extra.customerId = customers.company;
          if (s === 5 && t === 0) {
            // Every other kind of item in one sale: 2.375 kg, a visit, zero-rated, exempt, a kit.
            lines.length = 0;
            const quantities = [2375n, 1000n, 2000n, 1000n, 1000n];
            catalogue.specials.forEach((item, k) =>
              lines.push({ item, quantityMilli: quantities[k]! }),
            );
          }
          const total = saleTotal(lines);
          const method = (['cash', 'cash', 'card', 'split'] as const)[s % 4]!;
          const cash = (amount: bigint) => ({
            paymentMethodId: ref.cash,
            amountFils: amount.toString(),
            tenderedFils: (((amount + 499n) / 500n) * 500n).toString(),
          });
          const card = (amount: bigint) => ({
            paymentMethodId: ref.card,
            amountFils: amount.toString(),
            approvalCode: `R${t}${s}`.slice(0, 12),
          });
          const half = total / 2n;
          const payments =
            method === 'cash'
              ? [cash(total)]
              : method === 'card'
                ? [card(total)]
                : half > 0n
                  ? [card(half), cash(total - half)]
                  : [cash(total)];
          const sale = (await till.cashier('POST', '/api/v1/pos/sales', {
            cartId: crypto.randomUUID(),
            lines: body(lines),
            payments,
            ...extra,
          })) as { document: { id: string; lines: { id: string }[] } };
          await till.cashier('POST', `/api/v1/pos/receipts/${sale.document.id}/printed`);
          till.sales.push({ id: sale.document.id, lines: sale.document.lines, method });
        }
      };

      const oversell = async () => {
        const till = tills[0]!;
        const lines: SaleLine[] = [{ item: scarce, quantityMilli: 3000n }];
        const total = saleTotal(lines);
        const sale = (await till.cashier('POST', '/api/v1/pos/sales', {
          cartId: crypto.randomUUID(),
          lines: body(lines),
          payments: [
            { paymentMethodId: ref.card, amountFils: total.toString(), approvalCode: 'OVR1' },
          ],
          oversellApprovalId: await server.approval(till.cashier, 'pos.oversell'),
        })) as { oversellAdjustmentNumber: string | null };
        oversellNumber = sale.oversellAdjustmentNumber;
        if (!oversellNumber) throw new RehearsalError('The oversell made no adjustment to review');
      };

      const office = async () => {
        // Quotation → advance (30%) → progress payment (20%) → final invoice with deductions (0013).
        const quoted = saleTotal([{ item: items[1]!, quantityMilli: 20_000n }]);
        const quotation = (await owner('POST', '/api/v1/sales/quotations', {
          customerId: customers.company,
          businessLineId: ref.construction,
          subject: 'Pool construction 10 x 5 m',
          lines: [{ itemId: items[1]!.id, quantityMilli: '20000' }],
        })) as { id: string; rowVersion: number };
        const sent = (await owner('POST', `/api/v1/sales/quotations/${quotation.id}/action`, {
          action: 'send',
          rowVersion: quotation.rowVersion,
        })) as { rowVersion: number };
        const advance = (await owner('POST', '/api/v1/sales/payments', {
          customerId: customers.company,
          part: { paymentMethodId: ref.bank, amountFils: ((quoted * 3n) / 10n).toString() },
          asAdvance: true,
          quotationId: quotation.id,
        })) as { advanceInvoice: { id: string } | null; payment: { id: string } };
        const progressPayment = (await owner('POST', '/api/v1/sales/payments', {
          customerId: customers.company,
          part: { paymentMethodId: ref.bank, amountFils: (quoted / 5n).toString() },
          asAdvance: true,
          quotationId: quotation.id,
        })) as { advanceInvoice: { id: string } | null };
        if (!advance.advanceInvoice || !progressPayment.advanceInvoice)
          throw new RehearsalError('An advance payment made no tax invoice');
        const draft = (await owner('POST', `/api/v1/sales/quotations/${quotation.id}/convert`, {
          rowVersion: sent.rowVersion,
        })) as {
          id: string;
          rowVersion: number;
          lines: { itemId: string; quantityMilli: string; quotationLineId?: string }[];
        };
        const withDeductions = (await owner('PUT', `/api/v1/sales/invoices/${draft.id}`, {
          customerId: customers.company,
          quotationId: quotation.id,
          businessLineId: ref.construction,
          lines: [{ itemId: items[1]!.id, quantityMilli: '20000' }],
          deductions: [
            { advanceDocumentId: advance.advanceInvoice.id },
            { advanceDocumentId: progressPayment.advanceInvoice.id },
          ],
          rowVersion: draft.rowVersion,
        })) as { rowVersion: number };
        const final = (await owner('POST', `/api/v1/sales/documents/${draft.id}/issue`, {
          rowVersion: withDeductions.rowVersion,
        })) as { id: string };
        a4.final = final.id;
        a4.advance = advance.advanceInvoice.id;
        a4.advancePayment = advance.payment.id;

        // A credit sale to the VAT-registered company, then its receipt (oldest first) and a
        // cheque that bounces (RVS-).
        const credit = (await owner('POST', '/api/v1/sales/invoices', {
          customerId: customers.company,
          lines: [
            { itemId: items[2]!.id, quantityMilli: '40000' },
            { itemId: items[3]!.id, quantityMilli: '20000', lineDiscountBp: 500 },
          ],
        })) as { id: string; rowVersion: number };
        const issued = (await owner('POST', `/api/v1/sales/documents/${credit.id}/issue`, {
          rowVersion: credit.rowVersion,
        })) as { id: string; totalFils: string; lines: { id: string }[] };
        a4.credit = issued.id;
        await owner('POST', '/api/v1/sales/payments', {
          customerId: customers.company,
          part: { paymentMethodId: ref.bank, amountFils: '10000' },
        });
        const cheque = (await owner('POST', '/api/v1/sales/payments', {
          customerId: customers.company,
          part: {
            paymentMethodId: ref.cheque,
            amountFils: '5000',
            reference: 'CHQ-000123',
            chequeDate: new Date().toISOString().slice(0, 10),
            chequeBank: 'Rehearsal Bank',
          },
        })) as { payment: { id: string } };
        await owner('POST', `/api/v1/sales/payments/${cheque.payment.id}/reverse`, {
          reasonCodeId: ref.bounced,
          approvalId: await server.approval(owner, 'payments.reverse'),
        });
        a4.payment = cheque.payment.id;

        // A credit note (two pieces back, broken) and a debit note on the credit sale.
        const cn = (await owner('POST', '/api/v1/sales/notes', {
          kind: 'credit_note',
          originalDocumentId: issued.id,
          reasonCodeId: ref.cnReturn,
          reasonText: 'Rehearsal: two pieces came back broken',
          lines: [
            {
              originalLineId: issued.lines[0]!.id,
              quantityMilli: '2000',
              returnStockStatus: 'defective',
            },
          ],
        })) as { id: string };
        const dn = (await owner('POST', '/api/v1/sales/notes', {
          kind: 'debit_note',
          originalDocumentId: issued.id,
          reasonCodeId: ref.dnPrice,
          reasonText: 'Rehearsal: price correction',
          lines: [
            { originalLineId: issued.lines[1]!.id, quantityMilli: '1000', unitPrice4dp: '50000' },
          ],
        })) as { id: string };
        a4.creditNote = cn.id;
        a4.debitNote = dn.id;
        a4.quotation = quotation.id;
        // A simplified A4 invoice for the villa, paid by card at issue.
        const villa = (await owner('POST', '/api/v1/sales/invoices', {
          customerId: customers.villa,
          lines: [{ itemId: items[4]!.id, quantityMilli: '1000' }],
        })) as { id: string; rowVersion: number; totalFils: string };
        const villaIssued = (await owner('POST', `/api/v1/sales/documents/${villa.id}/issue`, {
          rowVersion: villa.rowVersion,
          payments: [
            { paymentMethodId: ref.card, amountFils: villa.totalFils, approvalCode: 'VILLA1' },
          ],
        })) as { id: string };
        a4.villa = villaIssued.id;
      };

      await Promise.all([...tills.map((till, t) => sell(till, t)), oversell(), office()]);
    });

    // ---- Returns: one to sellable stock (cash back), one to defective (card back) --------------
    await step('returns', async () => {
      const till = tills[0]!;
      for (const [kind, status] of [
        ['cash', 'available'],
        ['card', 'defective'],
      ] as const) {
        const sale = till.sales.find((s) => s.method === kind)!;
        await till.cashier('POST', '/api/v1/pos/returns', {
          originalDocumentId: sale.id,
          reasonCodeId: ref.cnReturn,
          reasonText: `Rehearsal: a ${status} return`,
          lines: [
            { originalLineId: sale.lines[0]!.id, quantityMilli: '1000', returnStockStatus: status },
          ],
          approvalId: await server.approval(till.cashier, 'credit_notes.issue'),
        });
      }
    });

    // ---- Cash in and out of the drawer, a drop, the X report ------------------------------------
    await step('cash_movements', async () => {
      const till = tills[0]!;
      await till.cashier('POST', '/api/v1/shifts/current/movements', {
        movementType: 'paid_in',
        amountFils: '5000',
        reasonCodeId: ref.changeFloat,
      });
      await till.cashier('POST', '/api/v1/shifts/current/movements', {
        movementType: 'paid_out',
        amountFils: '2000',
        reasonCodeId: ref.petty,
        note: 'Rehearsal: water bottles',
        approvalId: await server.approval(till.cashier, 'cash.paid_out', { amountFils: '2000' }),
      });
      await till.cashier('POST', '/api/v1/shifts/current/movements', {
        movementType: 'cash_drop',
        amountFils: '20000',
      });
      for (const t of tills) await t.cashier('GET', '/api/v1/shifts/current/x-report');
    });

    // ---- Stock: an increase, a decrease, a count with variances ---------------------------------
    await step('stock', async () => {
      await storekeeper('POST', '/api/v1/stock/adjustments', {
        kind: 'increase',
        reasonCodeId: ref.found,
        lines: [{ itemId: items[5]!.id, quantityMilli: '2000' }],
      });
      await storekeeper('POST', '/api/v1/stock/adjustments', {
        kind: 'decrease',
        reasonCodeId: ref.damaged,
        lines: [{ itemId: items[6]!.id, quantityMilli: '1000' }],
      });
      const counted = items.slice(7, 10);
      const count = (await owner('POST', '/api/v1/stock/counts', {
        scope: 'selected',
        itemIds: counted.map((i) => i.id),
      })) as { id: string; rowVersion: number; lines: { id: string; itemId: string }[] };
      // One piece missing on the first, the others as expected (blind count, 0044).
      const onHand = async (itemId: string) =>
        (
          await sql<{ q: string }>`SELECT coalesce(sum(quantity), 0)::text AS q FROM inv.balances
                                    WHERE item_id = ${itemId}::bigint AND stock_status = 'available'`.execute(
            server.db,
          )
        ).rows[0]!.q;
      const lines = [];
      for (const [i, line] of count.lines.entries()) {
        const q = Math.round(Number(await onHand(line.itemId)) * 1000) - (i === 0 ? 1000 : 0);
        lines.push({ lineId: line.id, countedMilli: String(q) });
      }
      const filled = (await owner('PUT', `/api/v1/stock/counts/${count.id}/lines`, { lines })) as {
        rowVersion: number;
      };
      await owner('POST', `/api/v1/stock/counts/${count.id}/post`, {
        rowVersion: filled.rowVersion ?? count.rowVersion,
        reasons: [
          { lineId: count.lines[0]!.id, reasonCodeId: ref.loss, note: 'Rehearsal: one missing' },
        ],
      });
    });

    // ---- Labels ---------------------------------------------------------------------------------
    await step('labels', async () => {
      const design = (await owner('GET', '/api/v1/label-design')) as { versionId: string };
      await owner('POST', '/api/v1/label-prints', {
        sizeId: ref.labelSize,
        designVersionId: design.versionId,
        source: 'list',
        lines: items.slice(0, 3).map((it) => ({
          itemId: it.id,
          copies: 2,
          price: {
            price4dp: it.price4dp.toString(),
            includesVat: it.includesVat,
            rateBp: Number(it.rateBp),
          },
        })),
      });
    });

    // ---- The oversell, reviewed by the storekeeper (0003) ---------------------------------------
    await step('oversell_review', async () => {
      const pending = (await storekeeper('GET', '/api/v1/stock/adjustments?review=pending')) as {
        adjustments: { id: string; docNumber: string; rowVersion: number }[];
      };
      const adjustment = pending.adjustments.find((a) => a.docNumber === oversellNumber);
      if (!adjustment)
        throw new RehearsalError(`Oversell ${oversellNumber} not waiting for review`);
      await storekeeper('POST', `/api/v1/stock/adjustments/${adjustment.id}/review`, {
        note: 'Rehearsal: counted, the stock was there',
        rowVersion: adjustment.rowVersion,
      });
    });

    // ---- Every kind of document printed by the real renderer -----------------------------------
    await step('printing', async () => {
      const pdfs = [
        `/api/v1/sales/documents/${tills[0]!.sales[0]!.id}/pdf`,
        `/api/v1/sales/documents/${a4.credit}/pdf`,
        `/api/v1/sales/documents/${a4.advance}/pdf`,
        `/api/v1/sales/documents/${a4.final}/pdf`,
        `/api/v1/sales/documents/${a4.creditNote}/pdf`,
        `/api/v1/sales/documents/${a4.debitNote}/pdf`,
        `/api/v1/sales/documents/${a4.villa}/pdf`,
        `/api/v1/sales/quotations/${a4.quotation}/pdf`,
        `/api/v1/sales/payments/${a4.advancePayment}/pdf`,
        `/api/v1/customers/${customers.company}/statement/pdf?from=${today()}&to=${today()}`,
      ];
      for (const url of pdfs) {
        const file = Buffer.from(
          ((await owner('GET', url)) as { dataBase64: string }).dataBase64,
          'base64',
        );
        if (!isPdf(file)) throw new RehearsalError(`${url}: not a PDF`);
        if (!pdfHasText(file)) throw new RehearsalError(`${url}: a blank PDF`);
      }
    });

    // ---- Shifts close: blind counts, one approved recount, the variance accepted ----------------
    await step('shifts_close', async () => {
      const expected = async (shiftId: string) =>
        BigInt(
          (
            await sql<{
              e: string;
            }>`SELECT cash.expected_cash(${shiftId}::bigint)::text AS e`.execute(server.db)
          ).rows[0]!.e,
        );
      const count = (amount: bigint) => ({
        lines: [{ denominationId: ref.note100, quantity: Number(amount / 10_000n) }],
        otherAmountFils: (amount % 10_000n).toString(),
      });
      for (const [t, till] of tills.entries()) {
        const exact = await expected(till.shiftId);
        if (t === 0) {
          // Five dirhams short, then counted again with a supervisor's approval: exact.
          await till.cashier('POST', '/api/v1/shifts/current/count', count(exact - 500n));
          await till.cashier('POST', '/api/v1/shifts/current/recount', {
            ...count(exact),
            approvalId: await server.approval(till.cashier, 'shifts.recount'),
          });
        } else if (t === 1) {
          // Two dirhams over: the variance stays, and the accountant accepts it.
          await till.cashier('POST', '/api/v1/shifts/current/count', count(exact + 200n));
        } else {
          await till.cashier('POST', '/api/v1/shifts/current/count', count(exact));
        }
        await till.cashier('POST', '/api/v1/shifts/current/close', {});
      }
      const pending = (await accountant('GET', '/api/v1/shifts?pendingAcceptance=true')) as {
        shifts: { id: string }[];
      };
      for (const s of pending.shifts) {
        await accountant('POST', `/api/v1/shifts/${s.id}/accept-variance`, {
          note: 'Rehearsal: accepted after checking',
        });
      }
      // Each Z report agrees with what its till did: its sales, its returns, its over/short.
      for (const [t, till] of tills.entries()) {
        const z = (await accountant('GET', `/api/v1/shifts/${till.shiftId}`)) as {
          salesCount: number;
          returnsCount: number;
          varianceFils: string | null;
        };
        const sold = till.sales.length + (t === 0 ? 1 : 0); // the oversell sale is on till 1
        const expected = {
          salesCount: sold,
          returnsCount: t === 0 ? 2 : 0,
          varianceFils: t === 1 ? '200' : '0',
        };
        const got = {
          salesCount: z.salesCount,
          returnsCount: z.returnsCount,
          varianceFils: z.varianceFils,
        };
        if (JSON.stringify(got) !== JSON.stringify(expected))
          throw new RehearsalError(
            `Z report of till ${t + 1}: ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
          );
      }
    });
  } catch (error) {
    if (!(error instanceof StopScript)) throw error;
  }
  return outcomes;
}

class StopScript extends Error {
  constructor(readonly outcome: StepOutcome) {
    super(outcome.detail);
  }
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
