/**
 * The integrity checks (decision 0086): run every night on the live database and on every
 * restore test. Each check returns how many problems it found and a few examples, never data a
 * person should not see in a log (ids and numbers only).
 */
import type pg from 'pg';
import { inSystemTx } from './db';

export interface CheckResult {
  ok: boolean;
  problems: number;
  examples: string[];
}
export type CheckResults = Record<string, CheckResult>;

/**
 * What the checks need from a connection: the backup service's own client, or the API's
 * connection when the owner or the accountant runs the reconciliation report (M7).
 */
export type Queryable = Pick<pg.ClientBase, 'query'>;

const APP_SCHEMAS = ['sys', 'auth', 'audit', 'md', 'inv', 'sales', 'cash', 'gl', 'ops'];

const result = (examples: string[], problems = examples.length): CheckResult => ({
  ok: problems === 0,
  problems,
  examples: examples.slice(0, 5),
});

/** The audit log's hash chain is unbroken (nothing changed, nothing removed). */
async function auditChain(client: Queryable): Promise<CheckResult> {
  const { rows } = await client.query<{
    ok: boolean;
    first_bad_seq: string | null;
    problem: string | null;
  }>('SELECT ok, first_bad_seq::text, problem FROM audit.verify_chain()');
  const r = rows[0]!;
  return r.ok ? result([]) : result([`entry ${r.first_bad_seq ?? '?'}: ${r.problem ?? 'broken'}`]);
}

/** Every journal entry balances, and its lines add up to its totals. */
async function journalsBalanced(client: Queryable): Promise<CheckResult> {
  const { rows } = await client.query<{ entry_number: string }>(
    `SELECT e.entry_number
       FROM gl.journal_entries e
       LEFT JOIN (SELECT entry_id, sum(debit_fils) AS d, sum(credit_fils) AS c
                    FROM gl.journal_lines GROUP BY entry_id) l ON l.entry_id = e.id
      WHERE e.total_debit_fils <> e.total_credit_fils
         OR coalesce(l.d, 0) <> e.total_debit_fils OR coalesce(l.c, 0) <> e.total_credit_fils
      ORDER BY e.id`,
  );
  return result(rows.map((r) => r.entry_number));
}

/** All the books together: total debits equal total credits. */
async function trialBalance(client: Queryable): Promise<CheckResult> {
  const { rows } = await client.query<{ d: string; c: string }>(
    'SELECT coalesce(sum(debit_fils), 0)::text AS d, coalesce(sum(credit_fils), 0)::text AS c FROM gl.journal_lines',
  );
  const r = rows[0]!;
  return r.d === r.c ? result([]) : result([`debits ${r.d} fils ≠ credits ${r.c} fils`]);
}

/** Stock on hand equals the sum of the stock movements (golden rule 9). */
async function stockVsLedger(client: Queryable): Promise<CheckResult> {
  const { rows } = await client.query<{ k: string }>(
    `WITH m AS (SELECT item_id, warehouse_id, stock_status, sum(quantity) AS q, sum(value_fils) AS v
                  FROM inv.movements GROUP BY 1, 2, 3)
     SELECT format('item %s, warehouse %s, %s', coalesce(b.item_id, m.item_id),
                   coalesce(b.warehouse_id, m.warehouse_id), coalesce(b.stock_status, m.stock_status)) AS k
       FROM inv.balances b
       FULL JOIN m USING (item_id, warehouse_id, stock_status)
      WHERE coalesce(b.quantity, 0) <> coalesce(m.q, 0)
         OR coalesce(b.book_value_fils, 0) <> coalesce(m.v, 0)`,
  );
  return result(rows.map((r) => r.k));
}

/** Every numbered series is gapless: each number from the start to the last one used once. */
async function numberingGaps(client: Queryable): Promise<CheckResult> {
  const { rows: tables } = await client.query<{ t: string }>(
    `SELECT format('%I.%I', table_schema, table_name) AS t
       FROM information_schema.columns
      WHERE table_schema = ANY ($1) AND column_name IN ('series_id', 'seq_no')
      GROUP BY table_schema, table_name HAVING count(*) = 2 ORDER BY 1`,
    [APP_SCHEMAS],
  );
  if (tables.length === 0) return result([]);
  const used = tables
    .map(({ t }) => `SELECT series_id, seq_no FROM ${t} WHERE seq_no IS NOT NULL`)
    .join(' UNION ALL ');
  const { rows } = await client.query<{ code: string; problem: string }>(
    `WITH used AS (${used}),
          per AS (SELECT s.id, s.code, s.start_number, s.next_number,
                         count(u.seq_no) AS n, count(DISTINCT u.seq_no) AS distinct_n,
                         min(u.seq_no) AS lo, max(u.seq_no) AS hi
                    FROM sys.document_series s LEFT JOIN used u ON u.series_id = s.id
                   GROUP BY s.id)
     SELECT code, CASE
              WHEN n <> distinct_n THEN 'a number is used twice'
              WHEN n = 0 AND next_number <> start_number THEN 'numbers given but no document found'
              WHEN n > 0 AND (lo <> start_number OR hi <> next_number - 1 OR n <> hi - lo + 1)
                THEN format('numbers %s–%s with %s used', lo, hi, n)
            END AS problem
       FROM per
      WHERE n <> distinct_n OR (n = 0 AND next_number <> start_number)
         OR (n > 0 AND (lo <> start_number OR hi <> next_number - 1 OR n <> hi - lo + 1))
      ORDER BY code`,
  );
  return result(rows.map((r) => `${r.code}: ${r.problem}`));
}

/**
 * What each document and opening balance has received equals the payments and credit notes
 * applied to it (a reversal takes back what it reverses). Decision 0113: an invoice's status
 * comes from these, never from a typed amount.
 */
async function settlements(client: Queryable): Promise<CheckResult> {
  const { rows } = await client.query<{ k: string }>(
    `WITH paid AS (SELECT a.document_id, a.opening_balance_id,
                          sum(CASE WHEN p.payment_kind = 'reversal' THEN -a.amount_fils
                                   ELSE a.amount_fils END) AS f
                     FROM sales.payment_allocations a JOIN sales.payments p ON p.id = a.payment_id
                    GROUP BY 1, 2),
          credit AS (SELECT invoice_id AS document_id, opening_balance_id, sum(amount_fils) AS f
                       FROM sales.credit_allocations GROUP BY 1, 2
                     UNION ALL
                     SELECT credit_note_id, NULL, sum(amount_fils)
                       FROM sales.credit_allocations GROUP BY 1),
          applied AS (SELECT document_id, opening_balance_id, sum(f) AS f
                        FROM (SELECT * FROM paid UNION ALL SELECT * FROM credit) x GROUP BY 1, 2)
     SELECT format('document %s: %s fils settled, %s applied', d.id, d.settled_fils,
                   coalesce(a.f, 0)) AS k
       FROM sales.documents d
       LEFT JOIN applied a ON a.document_id = d.id AND a.opening_balance_id IS NULL
      WHERE d.settled_fils <> coalesce(a.f, 0)
     UNION ALL
     SELECT format('opening balance %s: %s fils settled, %s applied', o.id, o.settled_fils,
                   coalesce(a.f, 0))
       FROM sales.opening_balances o
       LEFT JOIN applied a ON a.opening_balance_id = o.id AND a.document_id IS NULL
      WHERE o.settled_fils <> coalesce(a.f, 0)`,
  );
  return result(rows.map((r) => r.k));
}

/**
 * M7 (decision 0119): every closed shift's expected cash is still what its payments and cash
 * movements add up to, and its counted cash is its final count (a recount replaces the first).
 */
async function cashShifts(client: Queryable): Promise<CheckResult> {
  const { rows } = await client.query<{ k: string }>(
    `SELECT format('shift %s: expected %s fils, now %s; counted %s fils, final count %s',
                   s.shift_number, s.expected_cash_fils, x.expected, s.counted_cash_fils,
                   coalesce(c.total_fils::text, 'none')) AS k
       FROM cash.shifts s
       CROSS JOIN LATERAL (SELECT cash.expected_cash(s.id) AS expected) x
       LEFT JOIN cash.counts c ON c.id = s.closing_count_id
      WHERE s.status = 'closed'
        AND (s.expected_cash_fils <> x.expected OR c.total_fils IS DISTINCT FROM s.counted_cash_fils)
      ORDER BY s.id`,
  );
  return result(rows.map((r) => r.k));
}

/** Every issued sales document's net and VAT are the sums of its lines (decision 0009). */
async function documentTotals(client: Queryable): Promise<CheckResult> {
  const { rows } = await client.query<{ k: string }>(
    `SELECT format('%s: net %s / VAT %s fils, lines %s / %s', d.doc_number, d.net_fils, d.vat_fils,
                   coalesce(l.net, 0), coalesce(l.vat, 0)) AS k
       FROM sales.documents d
       LEFT JOIN (SELECT document_id, sum(net_fils) AS net, sum(vat_fils) AS vat, count(*) AS n
                    FROM sales.document_lines GROUP BY 1) l ON l.document_id = d.id
      WHERE d.status = 'issued'
        AND (l.n IS NULL OR d.net_fils <> l.net OR d.vat_fils <> l.vat)
      ORDER BY d.id`,
  );
  return result(rows.map((r) => r.k));
}

/**
 * The invoice's format follows the customer as issued (0010/0071): a document with the customer's
 * TRN is a full tax invoice; a full one without a TRN is only an A4 invoice to a named customer;
 * every full invoice, debit note and advance invoice carries the customer's address. Each
 * document is numbered in its own series: POS sales in POS-, A4 invoices and advance payment
 * invoices in INV-, credit and debit notes in theirs (0011).
 */
async function invoiceFormats(client: Queryable): Promise<CheckResult> {
  const { rows } = await client.query<{ k: string }>(
    `SELECT format('%s: %s', d.doc_number, CASE
              WHEN d.bill_to_trn IS NOT NULL AND d.invoice_format <> 'full'
                THEN 'a TRN on a simplified invoice'
              WHEN d.invoice_format = 'full' AND d.bill_to_trn IS NULL
                   AND NOT (d.channel = 'office' AND d.doc_type = 'invoice')
                THEN 'full format without a TRN'
              WHEN d.invoice_format = 'full' AND d.doc_type <> 'credit_note'
                   AND coalesce(btrim(d.bill_to_address), '') = ''
                THEN 'full format without the customer''s address'
              ELSE 'numbered in series ' || s.code END) AS k
       FROM sales.documents d
       JOIN sys.document_series s ON s.id = d.series_id
      WHERE d.status = 'issued'
        AND ((d.bill_to_trn IS NOT NULL AND d.invoice_format <> 'full')
             OR (d.invoice_format = 'full' AND d.bill_to_trn IS NULL
                 AND NOT (d.channel = 'office' AND d.doc_type = 'invoice'))
             OR (d.invoice_format = 'full' AND d.doc_type <> 'credit_note'
                 AND coalesce(btrim(d.bill_to_address), '') = '')
             OR s.doc_type <> CASE WHEN d.doc_type = 'advance_invoice' THEN 'invoice' ELSE d.doc_type END
             OR (d.doc_type IN ('invoice', 'advance_invoice')
                 AND s.channel IS DISTINCT FROM d.channel))
      ORDER BY d.id`,
  );
  return result(rows.map((r) => r.k));
}

/**
 * The VAT on the issued documents (credit notes taking it back) equals the movement on the
 * account mapped as output VAT. An advance's VAT is counted once: the final invoice's deduction
 * lines take it back (0013). The account is read from the mappings, never hard-coded (0018).
 */
async function vatLedger(client: Queryable): Promise<CheckResult> {
  const { rows } = await client.query<{ docs: string; ledger: string }>(
    `SELECT (SELECT coalesce(sum(CASE WHEN doc_type = 'credit_note' THEN -vat_fils ELSE vat_fils END), 0)
               FROM sales.documents WHERE status = 'issued')::text AS docs,
            (SELECT coalesce(sum(l.credit_fils - l.debit_fils), 0)
               FROM gl.journal_lines l
               JOIN gl.account_mappings m ON m.key = 'vat_output' AND m.account_id = l.account_id)::text AS ledger`,
  );
  const r = rows[0]!;
  return r.docs === r.ledger
    ? result([])
    : result([`VAT on documents ${r.docs} fils ≠ output VAT account ${r.ledger} fils`]);
}

/**
 * Everything that must be posted is posted (posting map): each issued document, payment and
 * cash movement, and each posted stock adjustment with a value. A manual entry on a control
 * account (receivables, customer advances, output VAT, inventory) is flagged: those accounts are
 * kept by the documents alone.
 */
async function postings(client: Queryable): Promise<CheckResult> {
  const { rows } = await client.query<{ k: string }>(
    `SELECT 'document ' || d.doc_number || ' not posted' AS k FROM sales.documents d
      WHERE d.status = 'issued' AND NOT EXISTS (SELECT 1 FROM gl.journal_entries e
             WHERE e.source_type = 'sales_document' AND e.sales_document_id = d.id)
     UNION ALL
     SELECT 'payment ' || p.doc_number || ' not posted' FROM sales.payments p
      WHERE NOT EXISTS (SELECT 1 FROM gl.journal_entries e
             WHERE e.source_type = 'payment' AND e.payment_id = p.id)
     UNION ALL
     SELECT 'cash movement ' || m.voucher_number || ' not posted' FROM cash.movements m
      WHERE NOT EXISTS (SELECT 1 FROM gl.journal_entries e
             WHERE e.source_type = 'cash_movement' AND e.cash_movement_id = m.id)
     UNION ALL
     SELECT 'stock adjustment ' || coalesce(a.doc_number, a.id::text) || ' not posted'
       FROM inv.adjustments a
      WHERE a.status = 'posted' AND coalesce(a.total_value_fils, 0) <> 0
        AND NOT EXISTS (SELECT 1 FROM gl.journal_entries e
             WHERE e.source_type = 'inventory_adjustment' AND e.inventory_adjustment_id = a.id)
     UNION ALL
     SELECT DISTINCT 'manual entry ' || e.entry_number || ' on the ' || m.key || ' account'
       FROM gl.journal_entries e
       JOIN gl.journal_lines l ON l.entry_id = e.id
       JOIN gl.account_mappings m ON m.account_id = l.account_id
        AND m.key IN ('ar_control', 'customer_advances', 'vat_output', 'inventory', 'inventory_defective')
      WHERE e.source_type = 'manual'`,
  );
  return result(rows.map((r) => r.k));
}

/**
 * The receivables account per customer equals what the customer's documents, payments and
 * opening balance add up to; no receivable line is without its customer. The customer advances
 * account equals the advance payment invoices not yet deducted or credited (0013).
 */
async function receivables(client: Queryable): Promise<CheckResult> {
  const { rows } = await client.query<{ k: string }>(
    `WITH ar AS (SELECT l.customer_id, sum(l.debit_fils - l.credit_fils) AS b
                   FROM gl.journal_lines l
                   JOIN gl.account_mappings m ON m.key = 'ar_control' AND m.account_id = l.account_id
                  GROUP BY 1),
          sub AS (SELECT customer_id, sum(b) AS b FROM (
                    SELECT customer_id,
                           sum(CASE WHEN doc_type = 'credit_note' THEN -total_fils ELSE total_fils END) AS b
                      FROM sales.documents WHERE status = 'issued' GROUP BY 1
                    UNION ALL
                    SELECT customer_id,
                           sum(CASE WHEN direction = 'in' THEN -amount_fils ELSE amount_fils END)
                      FROM sales.payments GROUP BY 1
                    UNION ALL
                    SELECT customer_id, amount_fils FROM sales.opening_balances) x
                  GROUP BY 1)
     SELECT format('customer %s: receivable account %s fils, documents and payments %s fils',
                   coalesce(coalesce(ar.customer_id, sub.customer_id)::text, '(none)'),
                   coalesce(ar.b, 0), coalesce(sub.b, 0)) AS k
       -- 0 stands for a receivable line without a customer (no customer has id 0).
       FROM ar FULL JOIN sub ON coalesce(sub.customer_id, 0) = coalesce(ar.customer_id, 0)
      WHERE coalesce(ar.b, 0) <> coalesce(sub.b, 0)
     UNION ALL
     SELECT format('customer advances account %s fils, advance invoices not yet used %s fils',
                   gl.b, docs.b)
       FROM (SELECT coalesce(sum(l.credit_fils - l.debit_fils), 0) AS b
               FROM gl.journal_lines l
               JOIN gl.account_mappings m ON m.key = 'customer_advances' AND m.account_id = l.account_id) gl,
            (SELECT coalesce(sum(net_fils - advance_used_net_fils), 0) AS b
               FROM sales.documents WHERE status = 'issued' AND doc_type = 'advance_invoice') docs
      WHERE gl.b <> docs.b`,
  );
  return result(rows.map((r) => r.k));
}

/**
 * Every anchor copied out of the audit chain (on Z reports and into backups) still matches the
 * chain at its position: a rewritten chain cannot match a copy kept elsewhere.
 */
async function auditAnchors(client: Queryable): Promise<CheckResult> {
  const { rows } = await client.query<{ k: string }>(
    `SELECT format('%s anchor %s at entry %s', x.anchor_kind, x.reference, x.chain_seq) AS k
       FROM audit.anchors x
       LEFT JOIN audit.log a ON a.chain_seq = x.chain_seq
       CROSS JOIN audit.chain_head h
      WHERE CASE WHEN x.chain_seq = 0 THEN x.chain_hash IS DISTINCT FROM h.genesis_hash
                 ELSE a.row_hash IS DISTINCT FROM x.chain_hash END
     UNION ALL
     SELECT format('Z report of shift %s at entry %s', s.shift_number, s.audit_anchor_seq)
       FROM cash.shifts s
       LEFT JOIN audit.log a ON a.chain_seq = s.audit_anchor_seq
       CROSS JOIN audit.chain_head h
      WHERE s.audit_anchor_seq IS NOT NULL
        AND CASE WHEN s.audit_anchor_seq = 0 THEN s.audit_anchor_hash IS DISTINCT FROM h.genesis_hash
                 ELSE a.row_hash IS DISTINCT FROM s.audit_anchor_hash END`,
  );
  return result(rows.map((r) => r.k));
}

const CHECKS: Record<string, (client: Queryable) => Promise<CheckResult>> = {
  audit_chain: auditChain,
  audit_anchors: auditAnchors,
  journals_balanced: journalsBalanced,
  trial_balance: trialBalance,
  stock_vs_ledger: stockVsLedger,
  numbering_gaps: numberingGaps,
  settlements,
  cash_shifts: cashShifts,
  document_totals: documentTotals,
  invoice_formats: invoiceFormats,
  vat_ledger: vatLedger,
  postings,
  receivables,
};

/** The check names, in the order they run (for the screens and the reconciliation report). */
export const CHECK_NAMES = Object.keys(CHECKS);

/** Runs every check on the database `client` is connected to. */
export async function runChecks(client: Queryable): Promise<CheckResults> {
  const results: CheckResults = {};
  for (const [name, check] of Object.entries(CHECKS)) {
    try {
      results[name] = await check(client);
    } catch (error) {
      results[name] = result([
        `could not run: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }
  return results;
}

export const allOk = (results: CheckResults): boolean => Object.values(results).every((r) => r.ok);

/** Records an integrity run on the live database (`live`), checking `target` (live or restored). */
export async function recordIntegrityRun(
  live: pg.Client,
  run: {
    kind: 'nightly' | 'restore_test' | 'manual' | 'after_start';
    database: string;
    backupRunId?: string | null;
  },
  results: CheckResults | Error,
): Promise<{ id: string; status: 'ok' | 'issues' | 'error' }> {
  const status = results instanceof Error ? 'error' : allOk(results) ? 'ok' : 'issues';
  const payload =
    results instanceof Error
      ? { error: { ok: false, problems: 1, examples: [results.message.slice(0, 500)] } }
      : results;
  return inSystemTx(live, `integrity checks: ${run.kind}`, async () => {
    const { rows } = await live.query<{ id: string }>(
      `INSERT INTO ops.integrity_runs (run_kind, database_name, backup_run_id, finished_at, status, results)
       VALUES ($1, $2, $3, now(), $4, $5) RETURNING id::text`,
      [run.kind, run.database, run.backupRunId ?? null, status, JSON.stringify(payload)],
    );
    return { id: rows[0]!.id, status };
  });
}

/**
 * A check of the live database: every night, and once after every start of the database (after a
 * power cut too, M6.2 part I).
 */
export async function liveIntegrity(
  live: pg.Client,
  kind: 'nightly' | 'after_start' = 'nightly',
): Promise<{ id: string; status: string }> {
  const { rows } = await live.query<{ db: string }>('SELECT current_database() AS db');
  const results = await runChecks(live).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  return recordIntegrityRun(live, { kind, database: rows[0]!.db }, results);
}

/** The nightly check of the live database. */
export const nightlyIntegrity = (live: pg.Client) => liveIntegrity(live, 'nightly');

/** The database started after the last check made after a start: one is due now. */
export async function startCheckDue(live: pg.Client): Promise<boolean> {
  const { rows } = await live.query<{ due: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM ops.integrity_runs
                         WHERE run_kind = 'after_start'
                           AND started_at >= pg_postmaster_start_time()) AS due`,
  );
  return rows[0]!.due;
}
