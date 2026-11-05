/**
 * A rehearsal's result as a short Markdown table (M7): the busy day's GitHub run summary and the
 * console. Steps, checks, speed and what the day did; nothing that names a real person or customer
 * (the rehearsal has none).
 */
import type { RehearsalReport } from './run';

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const mark = (ok: boolean) => (ok ? '✅' : '❌');

/** Text that stays inside its table cell: backslashes and pipes escaped, one line. */
export const cellText = (text: string): string =>
  text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\s*[\r\n]+\s*/g, ' ');

export function summaryMarkdown(report: RehearsalReport): string {
  const out: string[] = [];
  out.push(
    `## ${mark(report.ok)} Rehearsal (${report.size}): ${report.ok ? 'green' : 'red'}`,
    '',
    '| Step | Result | Time |',
    '|---|---|---|',
    ...report.steps.map(
      (s) =>
        `| ${s.step} | ${mark(s.ok)}${s.detail ? ` ${cellText(s.detail)}` : ''} | ${seconds(s.ms)} |`,
    ),
  );
  if (report.checks) {
    out.push('', '| Check | End of the day | Restored copy |', '|---|---|---|');
    for (const [name, r] of Object.entries(report.checks)) {
      const restored = report.restoredChecks?.[name];
      const cell = (c: { ok: boolean; problems: number } | undefined) =>
        c ? (c.ok ? mark(true) : `${mark(false)} ${c.problems}`) : '—';
      out.push(`| ${name} | ${cell(r)} | ${cell(restored)} |`);
    }
  }
  if (report.speed) {
    out.push('', '| Speed (95%) | Measured | Target | Requests |', '|---|---|---|---|');
    for (const [kind, f] of Object.entries(report.speed)) {
      const measured = f.p95Ms === null ? '—' : `${f.p95Ms} ms`;
      out.push(`| ${kind} | ${mark(!f.slow)} ${measured} | ${f.targetMs} ms | ${f.samples} |`);
    }
  }
  if (report.totals) {
    out.push(
      '',
      Object.entries(report.totals)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · '),
    );
  }
  out.push('');
  return out.join('\n');
}
