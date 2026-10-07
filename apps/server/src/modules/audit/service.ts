/**
 * Settings → Audit log: read only. Every action, who, when, from which PC and what changed;
 * the chain check; and an export that is itself recorded.
 */
import type { FastifyRequest } from 'fastify';
import { sql, type Expression, type SqlBool } from 'kysely';
import type { AuditEntry, AuditPage, AuditQuery, ChainStatus } from '@artepool/shared/contracts';
import { recordEvent } from '../../platform/audit/events';
import type { Db } from '../../platform/db/pool';
import { withBusinessTx } from '../../platform/db/tx';
import { contextOf } from '../../platform/http/context';
import type { AppDeps } from '../../platform/http/deps';

/** The most rows one export may contain. */
export const EXPORT_LIMIT = 10_000;

const SETTINGS_TABLES = [
  'sys.settings',
  'sys.company_profile',
  'sys.document_series',
  'sys.branches',
];

const likeText = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function auditRows(db: Db, query: AuditQuery, limit: number) {
  let q = db
    .selectFrom('audit.log as l')
    .leftJoin('auth.users as u', 'u.id', 'l.user_id')
    .leftJoin('auth.devices as d', 'd.id', 'l.device_id')
    .select([
      'l.id',
      'l.chain_seq',
      'l.occurred_at',
      'l.action',
      'l.entity_type',
      'l.entity_id',
      'l.reason',
      'l.old_values',
      'l.new_values',
      'u.id as user_id',
      'u.username',
      'u.display_name_ar',
      'u.display_name_en',
      'd.id as device_id',
      'd.code as device_code',
      sql<string | null>`CASE l.entity_type
          WHEN 'auth.users' THEN (SELECT x.username FROM auth.users x WHERE x.id::text = l.entity_id)
          WHEN 'auth.devices' THEN (SELECT x.code FROM auth.devices x WHERE x.id::text = l.entity_id)
        END`.as('entity_label'),
    ])
    .orderBy('l.id', 'desc')
    .limit(limit);
  if (query.before) q = q.where('l.id', '<', BigInt(query.before));
  if (query.userId) q = q.where('l.user_id', '=', BigInt(query.userId));
  if (query.from) {
    q = q.where(
      'l.occurred_at',
      '>=',
      sql<Date>`(${query.from}::date)::timestamp AT TIME ZONE 'Asia/Dubai'`,
    );
  }
  if (query.to) {
    q = q.where(
      'l.occurred_at',
      '<',
      sql<Date>`((${query.to}::date + 1))::timestamp AT TIME ZONE 'Asia/Dubai'`,
    );
  }
  if (query.kind) {
    q = q.where((eb) => {
      const security = eb.or([
        eb('l.action', 'like', 'event:auth.%'),
        eb('l.entity_type', 'like', 'auth.%'),
      ]);
      const settings = eb.or([
        eb('l.entity_type', 'in', SETTINGS_TABLES),
        eb('l.action', 'like', 'event:audit.%'),
      ]);
      const kinds: Record<NonNullable<AuditQuery['kind']>, Expression<SqlBool>> = {
        security,
        settings,
        data: eb.not(eb.or([security, settings])),
      };
      return kinds[query.kind!];
    });
  }
  if (query.q) {
    const pattern = likeText(query.q);
    q = q.where((eb) =>
      eb.or([
        eb('l.action', 'ilike', pattern),
        eb('l.entity_type', 'ilike', pattern),
        eb('l.reason', 'ilike', pattern),
        eb('u.username', 'ilike', pattern),
        eb('u.display_name_ar', 'ilike', pattern),
        eb('u.display_name_en', 'ilike', pattern),
        eb('d.code', 'ilike', pattern),
        eb(sql`l.new_values::text`, 'ilike', pattern),
        eb(sql`l.old_values::text`, 'ilike', pattern),
      ]),
    );
  }
  return q;
}

type Row = Awaited<ReturnType<ReturnType<typeof auditRows>['execute']>>[number];

function entryOf(r: Row): AuditEntry {
  return {
    id: r.id.toString(),
    seq: r.chain_seq?.toString() ?? null,
    at: r.occurred_at.toISOString(),
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    entityLabel: r.entity_label,
    user:
      r.user_id !== null
        ? {
            id: r.user_id.toString(),
            username: r.username!,
            displayNameAr: r.display_name_ar!,
            displayNameEn: r.display_name_en!,
          }
        : null,
    device: r.device_id !== null ? { id: r.device_id.toString(), code: r.device_code! } : null,
    reason: r.reason,
    oldValues: r.old_values as Record<string, unknown> | null,
    newValues: r.new_values as Record<string, unknown> | null,
  };
}

export async function listAudit(db: Db, query: AuditQuery): Promise<AuditPage> {
  const rows = await auditRows(db, query, query.limit + 1).execute();
  const page = rows.slice(0, query.limit).map(entryOf);
  return {
    entries: page,
    nextBefore: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function chainStatus(db: Db): Promise<ChainStatus> {
  const [head, last] = await Promise.all([
    db
      .selectFrom('audit.chain_head')
      .select(['last_seq', sql<string>`left(encode(last_hash, 'hex'), 16)`.as('fingerprint')])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('audit.verifications')
      .select(['finished_at', 'result', 'rows_checked', 'first_bad_seq'])
      .orderBy('id', 'desc')
      .executeTakeFirst(),
  ]);
  return {
    lastSeq: head.last_seq.toString(),
    fingerprint: head.fingerprint,
    lastCheck: last
      ? {
          at: last.finished_at.toISOString(),
          ok: last.result === 'ok',
          rowsChecked: last.rows_checked.toString(),
          firstBadSeq: last.first_bad_seq?.toString() ?? null,
        }
      : null,
  };
}

/** "Verify now": recomputes the whole chain and records the check (and who asked). */
export async function verifyNow(deps: AppDeps, request: FastifyRequest): Promise<ChainStatus> {
  await withBusinessTx(deps.db, contextOf(request, { reason: 'audit chain check' }), (trx) =>
    sql`SELECT * FROM audit.verify_and_record()`.execute(trx),
  );
  return chainStatus(deps.db);
}

const csvCell = (value: unknown): string => {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
};

const dubai = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', hour12: false });

/**
 * CSV for Excel (UTF-8 with BOM so Arabic shows correctly). The export is itself written to the
 * audit log with its filters and row count (PRD: exports are permission-controlled and logged).
 */
export async function exportAudit(
  deps: AppDeps,
  request: FastifyRequest,
  query: AuditQuery,
): Promise<string> {
  const rows = (await auditRows(deps.db, query, EXPORT_LIMIT).execute()).map(entryOf);
  await withBusinessTx(deps.db, contextOf(request), (trx) =>
    recordEvent(trx, 'audit.exported', {
      data: { rows: rows.length, filters: { ...query, limit: undefined } },
    }),
  );
  const header = [
    'seq',
    'time_al_ain',
    'user',
    'device',
    'action',
    'record',
    'record_id',
    'name',
    'reason',
    'before',
    'after',
  ];
  const lines = rows.map((e) =>
    [
      e.seq,
      dubai(e.at),
      e.user?.username,
      e.device?.code,
      e.action,
      e.entityType,
      e.entityId,
      e.entityLabel,
      e.reason,
      e.oldValues,
      e.newValues,
    ]
      .map(csvCell)
      .join(','),
  );
  return `\uFEFF${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`;
}
