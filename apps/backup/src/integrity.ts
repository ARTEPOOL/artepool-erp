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

const APP_SCHEMAS = ['sys', 'auth', 'audit', 'md', 'inv', 'sales', 'cash', 'gl', 'ops'];

const result = (examples: string[], problems = examples.length): CheckResult => ({
  ok: problems === 0,
  problems,
  examples: examples.slice(0, 5),
});

/** The audit log's hash chain is unbroken (nothing changed, nothing removed). */
async function auditChain(client: pg.Client): Promise<CheckResult> {
  const { rows } = await client.query<{
    ok: boolean;
    first_bad_seq: string | null;
    problem: string | null;
  }>('SELECT ok, first_bad_seq::text, problem FROM audit.verify_chain()');
  const r = rows[0]!;
  return r.ok ? result([]) : result([`entry ${r.first_bad_seq ?? '?'}: ${r.problem ?? 'broken'}`]);
}

/** Every journal entry balances, and its lines add up to its totals. */
async function journalsBalanced(client: pg.Client): Promise<CheckResult> {
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
async function trialBalance(client: pg.Client): Promise<CheckResult> {
  const { rows } = await client.query<{ d: string; c: string }>(
    'SELECT coalesce(sum(debit_fils), 0)::text AS d, coalesce(sum(credit_fils), 0)::text AS c FROM gl.journal_lines',
  );
  const r = rows[0]!;
  return r.d === r.c ? result([]) : result([`debits ${r.d} fils ≠ credits ${r.c} fils`]);
}

/** Stock on hand equals the sum of the stock movements (golden rule 9). */
async function stockVsLedger(client: pg.Client): Promise<CheckResult> {
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
async function numberingGaps(client: pg.Client): Promise<CheckResult> {
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

const CHECKS: Record<string, (client: pg.Client) => Promise<CheckResult>> = {
  audit_chain: auditChain,
  journals_balanced: journalsBalanced,
  trial_balance: trialBalance,
  stock_vs_ledger: stockVsLedger,
  numbering_gaps: numberingGaps,
};

/** Runs every check on the database `client` is connected to. */
export async function runChecks(client: pg.Client): Promise<CheckResults> {
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
