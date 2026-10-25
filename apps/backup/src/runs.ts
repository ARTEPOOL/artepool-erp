/** One row in ops.backup_runs per backup, upload, drive copy or restore test (decision 0086). */
import type pg from 'pg';
import { inSystemTx } from './db';

export type RunKind = 'logical_dump' | 'offsite_upload' | 'offline_copy' | 'restore_test';

export interface RunResult {
  target?: string | null;
  fileName?: string | null;
  sizeBytes?: number | null;
  sha256?: Buffer | null;
  encrypted?: boolean;
  chainSeq?: string | null;
  chainHash?: Buffer | null;
  details?: Record<string, unknown> | null;
}

export async function startRun(
  client: pg.Client,
  kind: RunKind,
  options: { requestId?: string | null; target?: string | null } = {},
): Promise<string> {
  return inSystemTx(client, `backup service: ${kind} started`, async () => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO ops.backup_runs (kind, request_id, target) VALUES ($1, $2, $3) RETURNING id::text`,
      [kind, options.requestId ?? null, options.target ?? null],
    );
    return rows[0]!.id;
  });
}

export async function finishRun(client: pg.Client, id: string, result: RunResult): Promise<void> {
  await inSystemTx(client, 'backup service: finished', () =>
    client.query(
      `UPDATE ops.backup_runs
          SET status = 'success', finished_at = now(), target = coalesce($2, target),
              file_name = $3, size_bytes = $4, sha256 = $5, encrypted = $6,
              audit_chain_seq = $7, audit_chain_hash = $8, details = $9
        WHERE id = $1`,
      [
        id,
        result.target ?? null,
        result.fileName ?? null,
        result.sizeBytes ?? null,
        result.sha256 ?? null,
        result.encrypted ?? false,
        result.chainSeq ?? null,
        result.chainHash ?? null,
        result.details ? JSON.stringify(result.details) : null,
      ],
    ),
  );
}

/** Records a failure with a short message (never a password or a key). */
export async function failRun(client: pg.Client, id: string, error: unknown): Promise<void> {
  const message =
    (error instanceof Error ? error.message : String(error)).slice(0, 2000) || 'failed';
  await inSystemTx(client, 'backup service: failed', () =>
    client.query(
      `UPDATE ops.backup_runs SET status = 'failed', finished_at = now(), error_message = $2
        WHERE id = $1`,
      [id, message],
    ),
  );
}
