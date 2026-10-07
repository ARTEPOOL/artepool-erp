import type pg from 'pg';

export interface ChainCheck {
  ok: boolean;
  rowsChecked: number;
  firstBadEntry: number | null;
  problem: string | null;
  lastEntry: number;
  fingerprint: string;
}

/**
 * Checks the whole audit chain and records the check itself (audit.verifications + an audit event),
 * as the SYSTEM user. `client` must be connected as artepool_api.
 */
export async function verifyAuditChain(client: pg.Client): Promise<ChainCheck> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT sys.set_context(1, p_reason => 'audit chain check')`);
    const { rows } = await client.query<{
      result: string;
      rows_checked: string;
      first_bad_seq: string | null;
      details: string | null;
    }>(
      'SELECT result, rows_checked::text, first_bad_seq::text, details FROM audit.verify_and_record()',
    );
    const head = await client.query<{ seq: string; fp: string }>(
      `SELECT last_seq::text AS seq, left(encode(last_hash, 'hex'), 16) AS fp FROM audit.chain_head`,
    );
    await client.query('COMMIT');
    const r = rows[0]!;
    return {
      ok: r.result === 'ok',
      rowsChecked: Number(r.rows_checked),
      firstBadEntry: r.first_bad_seq === null ? null : Number(r.first_bad_seq),
      problem: r.details,
      lastEntry: Number(head.rows[0]!.seq),
      fingerprint: head.rows[0]!.fp,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Plain-language report for the owner. */
export function describeCheck(check: ChainCheck): string {
  const count = check.rowsChecked.toLocaleString('en-US');
  if (check.ok) {
    return [
      `OK — the audit chain is intact: ${count} entries checked, none changed, none missing.`,
      `Latest entry: #${check.lastEntry}, fingerprint ${check.fingerprint}.`,
    ].join('\n');
  }
  return [
    `BROKEN — the audit chain shows tampering.`,
    `Problem: ${check.problem ?? 'unknown'}.`,
    `${count} entries before it were checked and are intact.`,
    `What to do: stop using the system, keep this message, and contact the system administrator before doing anything else.`,
  ].join('\n');
}
