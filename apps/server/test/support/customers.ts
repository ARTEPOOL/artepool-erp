/**
 * Set-up for the screen tests (Playwright): a credit customer, optionally owing an opening balance
 * past its due date (decision 0114) — created through the same services the screens use.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createCustomer, setCustomerCredit } from '../../src/modules/parties/customers';
import { addOpeningBalance } from '../../src/modules/sales/statement';
import { withBusinessTx } from '../../src/platform/db/tx';
import type { TestServer } from './server';

export async function addCreditCustomer(
  server: TestServer,
  ownerId: bigint,
  customer: {
    name: string;
    phone: string;
    creditLimitFils: string;
    /** An opening balance due yesterday (overdue), when given. */
    overdueFils?: string;
  },
): Promise<{ id: string }> {
  return withBusinessTx(
    server.db,
    { userId: ownerId, requestId: randomUUID(), reason: 'e2e: credit customer' },
    async (trx) => {
      const created = await createCustomer(trx, {
        customerType: 'contractor',
        name: customer.name,
        phone: customer.phone,
        isVatRegistered: false,
      });
      await setCustomerCredit(trx, BigInt(created.id), {
        rowVersion: created.rowVersion,
        reason: 'e2e: a credit customer',
        credit: {
          mode: 'credit',
          creditLimitFils: customer.creditLimitFils,
          paymentTermsDays: 30,
        },
      });
      if (customer.overdueFils) {
        const { rows } = await sql<{ d: string }>`
          SELECT (sys.business_date(now()) - 1)::text AS d`.execute(trx);
        await addOpeningBalance(trx, {
          customerId: created.id,
          direction: 'receivable',
          amountFils: customer.overdueFils,
          dueDate: rows[0]!.d,
        });
      }
      return { id: created.id };
    },
  );
}
