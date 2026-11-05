/**
 * The reconciliation report (M7, decision 0119): the seven steps of the acceptance
 * reconciliation (§6.3). Every integrity check runs on the whole database, and the period adds
 * its own figures and checks:
 * - variances accepted;
 * - oversells reviewed;
 * - the period's VAT against the output VAT account;
 * - the last restore test.
 * Each run is kept (ops.integrity_runs, kind 'reconciliation') and audited. Owner and accountant.
 */
import { CompiledQuery, sql } from 'kysely';
import { runChecks, type CheckResult, type CheckResults, type Queryable } from '@artepool/backup';
import type {
  ReconciliationCheck,
  ReconciliationFigure,
  ReconciliationReport,
  ReconciliationRequest,
  ReconciliationStep,
  ReconciliationStepResult,
} from '@artepool/shared/contracts';
import type { Db } from '../../platform/db/pool';
import { filledByDatabase } from '../../platform/db/stamped';
import { withBusinessTx, type RequestContext } from '../../platform/db/tx';

/** The signed-in user's permissions, as the route guard loaded them. */
type Auth = { permissions: ReadonlySet<string> } | null;

/** Which integrity checks belong to which step (the order of §6.3). */
const STEP_CHECKS: Record<ReconciliationStep, string[]> = {
  stock: ['stock_vs_ledger'],
  cash: ['cash_shifts'],
  invoices: ['numbering_gaps', 'document_totals', 'invoice_formats'],
  vat: ['vat_ledger'],
  accounts: ['journals_balanced', 'trial_balance', 'postings', 'receivables', 'settlements'],
  audit: ['audit_chain', 'audit_anchors'],
  backup: [],
};

/** A long audit chain takes more than the API's usual 15 s: the report's own limit. */
const REPORT_TIMEOUT = '300s';

/** Every integrity check, on one API connection with the report's own time limit. */
async function allChecks(db: Db): Promise<CheckResults> {
  return db.connection().execute(async (conn) => {
    await sql`SET statement_timeout = ${sql.lit(REPORT_TIMEOUT)}`.execute(conn);
    try {
      const client = {
        query: (text: string, values?: unknown[]) =>
          conn.executeQuery(CompiledQuery.raw(text, values ?? [])),
      } as unknown as Queryable;
      return await runChecks(client);
    } finally {
      await sql`RESET statement_timeout`.execute(conn);
    }
  });
}

const check = (name: string, r: CheckResult): ReconciliationCheck => ({ name, ...r });
const fils = (key: string, value: bigint | string | null): ReconciliationFigure => ({
  key,
  kind: 'fils',
  value: value === null ? null : String(value),
});
const count = (key: string, value: bigint | string | number): ReconciliationFigure => ({
  key,
  kind: 'count',
  value: String(value),
});
const text = (key: string, value: string | null): ReconciliationFigure => ({
  key,
  kind: 'text',
  value,
});
const problems = (examples: string[], n = examples.length): CheckResult => ({
  ok: n === 0,
  problems: n,
  examples: examples.slice(0, 5),
});

async function stockStep(db: Db, from: string, to: string, seesCost: boolean) {
  const { rows } = await sql<{
    movements: string;
    oversells: string;
    pending: string;
    pending_list: string[] | null;
    value: string;
  }>`
    SELECT (SELECT count(*) FROM inv.movements
             WHERE movement_date BETWEEN ${from}::date AND ${to}::date)::text AS movements,
           (SELECT count(*) FROM inv.adjustments
             WHERE kind = 'oversell' AND status = 'posted'
               AND adjustment_date BETWEEN ${from}::date AND ${to}::date)::text AS oversells,
           (SELECT count(*) FROM inv.adjustments
             WHERE kind = 'oversell' AND review_status = 'pending')::text AS pending,
           (SELECT array_agg(coalesce(doc_number, id::text) ORDER BY id) FROM inv.adjustments
             WHERE kind = 'oversell' AND review_status = 'pending') AS pending_list,
           (SELECT coalesce(sum(book_value_fils), 0) FROM inv.balances)::text AS value`.execute(db);
  const r = rows[0]!;
  return {
    checks: [
      check(
        'oversells_reviewed',
        problems(
          (r.pending_list ?? []).map((n) => `oversell ${n} waits for review`),
          Number(r.pending),
        ),
      ),
    ],
    figures: [
      count('movements', r.movements),
      count('oversells', r.oversells),
      count('oversellsPending', r.pending),
      fils('stockValue', seesCost ? r.value : null),
    ],
  };
}

async function cashStep(db: Db, from: string, to: string) {
  const { rows } = await sql<{
    shifts: string;
    expected: string;
    counted: string;
    variance: string;
    open_variances: string[] | null;
  }>`
    WITH closed AS (
      SELECT s.* FROM cash.shifts s
       WHERE s.status = 'closed'
         AND (s.closed_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN ${from}::date AND ${to}::date)
    SELECT count(*)::text AS shifts,
           coalesce(sum(expected_cash_fils), 0)::text AS expected,
           coalesce(sum(counted_cash_fils), 0)::text AS counted,
           coalesce(sum(variance_fils), 0)::text AS variance,
           array_agg(shift_number ORDER BY id) FILTER (
             WHERE variance_fils <> 0
               AND NOT EXISTS (SELECT 1 FROM cash.variance_acceptances a WHERE a.shift_id = closed.id)
           ) AS open_variances
      FROM closed`.execute(db);
  const r = rows[0]!;
  return {
    checks: [
      check(
        'variances_accepted',
        problems((r.open_variances ?? []).map((n) => `shift ${n}: variance not accepted yet`)),
      ),
    ],
    figures: [
      count('shiftsClosed', r.shifts),
      fils('expectedCash', r.expected),
      fils('countedCash', r.counted),
      fils('variance', r.variance),
    ],
  };
}

async function invoicesStep(db: Db, from: string, to: string) {
  const { rows } = await sql<{ code: string; first: string; last: string; n: string }>`
    SELECT s.code, min(d.doc_number) AS first, max(d.doc_number) AS last, count(*)::text AS n
      FROM sales.documents d JOIN sys.document_series s ON s.id = d.series_id
     WHERE d.status = 'issued' AND d.issue_date BETWEEN ${from}::date AND ${to}::date
     GROUP BY s.code ORDER BY s.code`.execute(db);
  const { rows: totals } = await sql<{ sales: string }>`
    SELECT coalesce(sum(CASE WHEN doc_type = 'credit_note' THEN -total_fils ELSE total_fils END), 0)::text
           AS sales
      FROM sales.documents
     WHERE status = 'issued' AND issue_date BETWEEN ${from}::date AND ${to}::date`.execute(db);
  return {
    checks: [],
    figures: [
      ...rows.map((r) => text(`series:${r.code}`, `${r.first} … ${r.last} (${r.n})`)),
      fils('documentsTotal', totals[0]!.sales),
    ],
  };
}

async function vatStep(db: Db, from: string, to: string) {
  const { rows } = await sql<{
    invoices: string;
    advances: string;
    credits: string;
    debits: string;
    ledger: string;
  }>`
    SELECT coalesce(sum(vat_fils) FILTER (WHERE doc_type = 'invoice'), 0)::text AS invoices,
           coalesce(sum(vat_fils) FILTER (WHERE doc_type = 'advance_invoice'), 0)::text AS advances,
           coalesce(sum(vat_fils) FILTER (WHERE doc_type = 'credit_note'), 0)::text AS credits,
           coalesce(sum(vat_fils) FILTER (WHERE doc_type = 'debit_note'), 0)::text AS debits,
           (SELECT coalesce(sum(l.credit_fils - l.debit_fils), 0)
              FROM gl.journal_lines l
              JOIN gl.journal_entries e ON e.id = l.entry_id
              JOIN gl.account_mappings m ON m.key = 'vat_output' AND m.account_id = l.account_id
             WHERE e.entry_date BETWEEN ${from}::date AND ${to}::date)::text AS ledger
      FROM sales.documents
     WHERE status = 'issued' AND issue_date BETWEEN ${from}::date AND ${to}::date`.execute(db);
  const r = rows[0]!;
  const docs = BigInt(r.invoices) + BigInt(r.advances) + BigInt(r.debits) - BigInt(r.credits);
  const ledger = BigInt(r.ledger);
  return {
    checks: [
      check(
        'vat_period',
        problems(
          docs === ledger
            ? []
            : [`period VAT on documents ${docs} fils ≠ output VAT account ${ledger} fils`],
        ),
      ),
    ],
    figures: [
      fils('vatInvoices', r.invoices),
      fils('vatAdvances', r.advances),
      fils('vatCreditNotes', r.credits),
      fils('vatDebitNotes', r.debits),
      fils('vatDocuments', docs),
      fils('vatAccount', ledger),
    ],
  };
}

async function accountsStep(db: Db) {
  const { rows } = await sql<{ debits: string; receivables: string; advances: string }>`
    SELECT (SELECT coalesce(sum(debit_fils), 0) FROM gl.journal_lines)::text AS debits,
           (SELECT coalesce(sum(l.debit_fils - l.credit_fils), 0) FROM gl.journal_lines l
              JOIN gl.account_mappings m ON m.key = 'ar_control' AND m.account_id = l.account_id)::text
             AS receivables,
           (SELECT coalesce(sum(l.credit_fils - l.debit_fils), 0) FROM gl.journal_lines l
              JOIN gl.account_mappings m ON m.key = 'customer_advances' AND m.account_id = l.account_id)::text
             AS advances`.execute(db);
  const r = rows[0]!;
  return {
    checks: [],
    figures: [
      fils('totalDebits', r.debits),
      fils('receivables', r.receivables),
      fils('customerAdvances', r.advances),
    ],
  };
}

async function auditStep(db: Db) {
  const { rows } = await sql<{ last_seq: string; anchors: string }>`
    SELECT (SELECT last_seq FROM audit.chain_head WHERE id = 1)::text AS last_seq,
           (SELECT count(*) FROM audit.anchors)::text AS anchors`.execute(db);
  return {
    checks: [],
    figures: [count('chainEntries', rows[0]!.last_seq), count('anchors', rows[0]!.anchors)],
  };
}

async function backupStep(db: Db) {
  const last = await db
    .selectFrom('ops.integrity_runs')
    .select(['status', 'finished_at'])
    .where('run_kind', '=', 'restore_test')
    .where('finished_at', 'is not', null)
    .orderBy('finished_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  const examples = !last
    ? ['no restore test has run yet (System health → Restore test)']
    : last.status !== 'ok'
      ? [`the last restore test found problems (${last.status})`]
      : [];
  return {
    checks: [check('restore_test', problems(examples))],
    figures: [
      text('lastRestoreTest', last?.finished_at ? last.finished_at.toISOString() : null),
      text('lastRestoreResult', last?.status ?? null),
    ],
  };
}

/** Runs the report for the period, records it and returns it. */
export async function runReconciliation(
  db: Db,
  ctx: RequestContext,
  auth: Auth,
  request: ReconciliationRequest,
): Promise<ReconciliationReport> {
  const { from, to } = request;
  const startedAt = new Date();
  const results = await allChecks(db);
  const seesCost = auth?.permissions.has('stock.view_cost') ?? false;
  const extra: Record<
    ReconciliationStep,
    { checks: ReconciliationCheck[]; figures: ReconciliationFigure[] }
  > = {
    stock: await stockStep(db, from, to, seesCost),
    cash: await cashStep(db, from, to),
    invoices: await invoicesStep(db, from, to),
    vat: await vatStep(db, from, to),
    accounts: await accountsStep(db),
    audit: await auditStep(db),
    backup: await backupStep(db),
  };
  const steps: ReconciliationStepResult[] = (Object.keys(STEP_CHECKS) as ReconciliationStep[]).map(
    (step) => {
      const checks = [
        ...STEP_CHECKS[step].map((name) =>
          check(name, results[name] ?? problems(['the check did not run'])),
        ),
        ...extra[step].checks,
      ];
      return { step, ok: checks.every((c) => c.ok), checks, figures: extra[step].figures };
    },
  );
  const ok = steps.every((s) => s.ok);
  const finishedAt = new Date();
  const report = { from, to, ranAt: finishedAt.toISOString(), ok, steps };
  const run = await withBusinessTx(db, ctx, (trx) =>
    trx
      .insertInto('ops.integrity_runs')
      .values(
        filledByDatabase('ops.integrity_runs', {
          run_kind: 'reconciliation',
          database_name: sql<string>`current_database()`,
          started_at: startedAt,
          finished_at: finishedAt,
          status: ok ? 'ok' : 'issues',
          results: JSON.stringify(report),
          period_from: from,
          period_to: to,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  return { id: run.id.toString(), ...report };
}

/** A report kept earlier, by its id. */
export async function reconciliationById(db: Db, id: bigint): Promise<ReconciliationReport | null> {
  const row = await db
    .selectFrom('ops.integrity_runs')
    .select(['id', 'results'])
    .where('id', '=', id)
    .where('run_kind', '=', 'reconciliation')
    .executeTakeFirst();
  if (!row) return null;
  return { id: row.id.toString(), ...(row.results as unknown as Omit<ReconciliationReport, 'id'>) };
}
