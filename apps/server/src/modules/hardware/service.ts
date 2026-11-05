/**
 * The guided hardware check (M7 part D, decision 0119): the newest check of each PC, a new check
 * recorded on the PC it checks, and the A4 test page the laptop prints through the print dialog.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  hardwareStepsFor,
  type HardwareCheck,
  type HardwareCheckRequest,
  type HardwareChecksResponse,
} from '@artepool/shared/contracts';
import { fieldError } from '../../platform/db/versioned';
import type { DB } from '../../platform/db/schema.generated';
import type { DeviceInfo } from '../../platform/http/access';
import { company } from '../printing/service';
import { escapeHtml, fonts } from '../printing/templates';
import type { Db } from '../../platform/db/pool';

type Row = {
  id: bigint;
  device_code: string;
  device_name: string;
  created_at: Date;
  results: unknown;
  all_ok: boolean;
  display_name_ar: string;
  display_name_en: string;
};

const view = (r: Row): HardwareCheck => ({
  id: r.id.toString(),
  deviceCode: r.device_code,
  deviceName: r.device_name,
  checkedAt: r.created_at.toISOString(),
  checkedBy: { displayNameAr: r.display_name_ar, displayNameEn: r.display_name_en },
  results: r.results as HardwareCheck['results'],
  allOk: r.all_ok,
});

function checks(db: Kysely<DB>) {
  return db
    .selectFrom('ops.hardware_checks as h')
    .innerJoin('auth.devices as d', 'd.id', 'h.device_id')
    .innerJoin('auth.users as u', 'u.id', 'h.created_by')
    .select([
      'h.id',
      'd.code as device_code',
      'd.name as device_name',
      'h.created_at',
      'h.results',
      'h.all_ok',
      'u.display_name_ar',
      'u.display_name_en',
    ]);
}

export async function hardwareChecks(
  db: Kysely<DB>,
  device: DeviceInfo,
): Promise<HardwareChecksResponse> {
  const rows = (await checks(db)
    .where('d.status', '=', 'active')
    .where(
      'h.id',
      'in',
      sql<bigint>`(SELECT DISTINCT ON (device_id) id FROM ops.hardware_checks
                    ORDER BY device_id, created_at DESC, id DESC)`,
    )
    .orderBy('h.created_at', 'desc')
    .execute()) as Row[];
  return { checks: rows.map(view), steps: hardwareStepsFor(device.kind) };
}

/** Records a check of this PC: each of its steps once, nothing else. */
export async function recordHardwareCheck(
  trx: Transaction<DB>,
  device: DeviceInfo,
  body: HardwareCheckRequest,
): Promise<HardwareCheck> {
  const steps = hardwareStepsFor(device.kind);
  const given = body.results.map((r) => r.step);
  if (given.length !== steps.length || steps.some((s) => !given.includes(s)))
    throw fieldError('results', 'steps');
  const results = steps.map((step) => {
    const r = body.results.find((x) => x.step === step)!;
    return { step, outcome: r.outcome, note: r.note ?? null };
  });
  const inserted = await trx
    .insertInto('ops.hardware_checks')
    .values({
      device_id: device.id,
      results: JSON.stringify(results),
      all_ok: results.every((r) => r.outcome === 'ok'),
    } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  const row = (await checks(trx).where('h.id', '=', inserted.id).executeTakeFirstOrThrow()) as Row;
  return view(row);
}

/** The laptop's A4 test page: the shop's name, a frame at the page's margins and a 10 cm rule. */
export async function a4TestPageHtml(db: Db, deviceCode: string): Promise<string> {
  const { seller } = await company(db);
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai' });
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
${fonts()}
@page { size: A4; margin: 10mm; }
body { font-family: 'ARTEPOOL Arabic', 'Plex Arabic', sans-serif; margin: 0; }
.frame { box-sizing: border-box; height: 276mm; border: 0.5mm solid #111; padding: 12mm; }
h1 { font-size: 22pt; margin: 0 0 4mm; }
.en { font-family: 'Plex Arabic', sans-serif; color: #444; }
.rule { margin-top: 20mm; width: 100mm; height: 6mm; direction: ltr;
  background: repeating-linear-gradient(90deg, #111 0 0.3mm, transparent 0.3mm 10mm); border-bottom: 0.3mm solid #111; }
p { font-size: 12pt; }
</style></head><body><div class="frame">
<h1>صفحة تجربة A4 <span class="en">A4 test page</span></h1>
<p>${escapeHtml(seller.legal_name_ar)} · <span class="en">${escapeHtml(seller.legal_name_en)}</span></p>
<p><bdi>${escapeHtml(deviceCode)}</bdi> · <bdi>${escapeHtml(now)}</bdi></p>
<p>لو الإطار باين كامل والمسطرة طولها 10 سم بالظبط، الطباعة سليمة.</p>
<p class="en">If the whole frame shows and the rule is exactly 10 cm long, printing is right.</p>
<div class="rule"></div>
</div></body></html>`;
}
