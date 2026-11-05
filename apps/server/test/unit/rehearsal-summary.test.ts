import { describe, expect, it } from 'vitest';
import type { RehearsalReport } from '../../src/rehearsal/run';
import { speedOk } from '../../src/rehearsal/run';
import { summaryMarkdown } from '../../src/rehearsal/summary';

const speed = (p95: number | null, target: number) => ({
  p95Ms: p95,
  samples: p95 === null ? 0 : 100,
  targetMs: target,
  slow: p95 !== null && p95 > target,
});

const report = (over: Partial<RehearsalReport> = {}): RehearsalReport => ({
  size: 'busy',
  ok: true,
  database: 'artepool_rehearsal_0123456789ab',
  startedAt: '2026-11-05T10:00:00Z',
  finishedAt: '2026-11-05T10:12:00Z',
  steps: [
    { step: 'database', ok: true, ms: 4200 },
    { step: 'the_day', ok: true, ms: 312_000 },
  ],
  checks: { audit_chain: { ok: true, problems: 0, examples: [] } },
  restoredChecks: { audit_chain: { ok: true, problems: 0, examples: [] } },
  speed: { search: speed(41, 300), scan: speed(12, 300), sale: speed(380, 2000) },
  totals: {
    posSales: 841,
    posReturns: 2,
    a4Documents: 9,
    payments: 900,
    shifts: 4,
    approvals: 42,
    labelPrints: 3,
    journalEntries: 1800,
    auditEntries: 20_000,
  },
  reconciliation: null,
  ...over,
});

describe('the rehearsal summary', () => {
  it('shows each step, check and speed figure, and what the day did', () => {
    const md = summaryMarkdown(report());
    expect(md).toContain('## ✅ Rehearsal (busy): green');
    expect(md).toContain('| the_day | ✅ | 312.0 s |');
    expect(md).toContain('| audit_chain | ✅ | ✅ |');
    expect(md).toContain('| sale | ✅ 380 ms | 2000 ms | 100 |');
    expect(md).toContain('posSales: 841');
  });

  it('a red step carries its reason, and a pipe in it cannot break the table', () => {
    const md = summaryMarkdown(
      report({
        ok: false,
        steps: [{ step: 'the_day', ok: false, ms: 900, detail: 'POST /x: 422 | RULE' }],
        checks: { settlements: { ok: false, problems: 3, examples: [] } },
        restoredChecks: null,
      }),
    );
    expect(md).toContain('## ❌ Rehearsal (busy): red');
    expect(md).toContain('| the_day | ❌ POST /x: 422 \\| RULE | 0.9 s |');
    expect(md).toContain('| settlements | ❌ 3 | — |');
  });

  it('speed is within the targets only when no figure is slow', () => {
    expect(speedOk(report().speed!)).toBe(true);
    expect(speedOk({ search: speed(301, 300), scan: speed(10, 300), sale: speed(100, 2000) })).toBe(
      false,
    );
    expect(
      speedOk({ search: speed(null, 300), scan: speed(null, 300), sale: speed(null, 2000) }),
    ).toBe(true);
  });
});
