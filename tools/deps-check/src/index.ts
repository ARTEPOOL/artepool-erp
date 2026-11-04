/**
 * The weekly dependency check: which known security advisories reach what we ship.
 *
 * - JavaScript: `pnpm audit --json --prod` (GitHub's advisory database). Shipped means: reached
 *   through a production dependency of the server, the backup service, the screens or the shared
 *   packages. Development tools and test libraries (jsdom, ESLint…) never ship.
 * - Rust: the crates linked into the Windows programs (`cargo tree` for the Windows target, normal
 *   dependencies without build-time macros), checked against OSV (RustSec and GitHub advisories).
 *
 * Only a critical or high advisory that reaches the shipped app fails the check; the rest are
 * listed in the summary. Pure functions here; the commands and the network are in cli.ts.
 */

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown';
export type Part = 'server' | 'screens' | 'windows';

export interface Finding {
  ecosystem: 'npm' | 'crates.io';
  package: string;
  version: string;
  /** The advisory's id (a GHSA id when there is one). */
  id: string;
  severity: Severity;
  /** The first fixed version(s), as the advisory says. */
  fixed: string;
  /** Reaches what we ship. */
  shipped: boolean;
  parts: Part[];
  /** RustSec's "unmaintained" / "unsound" notes: worth knowing, never failing. */
  informational: boolean;
  title: string;
}

/** The workspace packages whose production dependencies end up in the installers. */
export const SHIPPED_IMPORTERS: Record<string, Part[]> = {
  apps__server: ['server'],
  apps__backup: ['server'],
  db: ['server'],
  'packages__node-kit': ['server'],
  apps__desktop: ['screens'],
  packages__i18n: ['screens'],
  packages__shared: ['server', 'screens'],
};

const SEVERITIES: Severity[] = ['critical', 'high', 'moderate', 'low', 'unknown'];

export const blocking = (f: Finding): boolean =>
  f.shipped && !f.informational && (f.severity === 'critical' || f.severity === 'high');

// ------------------------------------------------------------------------------- JavaScript

interface AuditAdvisory {
  module_name?: unknown;
  severity?: unknown;
  github_advisory_id?: unknown;
  patched_versions?: unknown;
  title?: unknown;
  findings?: { version?: unknown; paths?: unknown }[];
}

const text = (value: unknown, otherwise: string): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : otherwise;

/** The findings of `pnpm audit --json`, one per advisory and package version. */
export function npmFindings(audit: unknown): Finding[] {
  const advisories = (audit as { advisories?: Record<string, AuditAdvisory> })?.advisories ?? {};
  const out: Finding[] = [];
  for (const a of Object.values(advisories)) {
    const severity = SEVERITIES.includes(a.severity as Severity)
      ? (a.severity as Severity)
      : 'unknown';
    for (const found of a.findings ?? []) {
      const paths = Array.isArray(found.paths) ? found.paths.map(String) : [];
      const parts = new Set<Part>();
      for (const path of paths) {
        for (const part of SHIPPED_IMPORTERS[path.split('>')[0] ?? ''] ?? []) parts.add(part);
      }
      out.push({
        ecosystem: 'npm',
        package: text(a.module_name, '?'),
        version: text(found.version, '?'),
        id: text(a.github_advisory_id, '?'),
        severity,
        fixed: text(a.patched_versions, '?'),
        shipped: parts.size > 0,
        parts: [...parts].sort(),
        informational: false,
        title: text(a.title, ''),
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------- Rust

/** `name vX.Y.Z` lines of `cargo tree --prefix none`, without our own (local path) crates. */
export function cratesFromTree(text: string): { name: string; version: string }[] {
  const seen = new Map<string, { name: string; version: string }>();
  for (const line of text.split('\n')) {
    // A version is digits, then a "-rc.1" / "+build" tail, then a space before the rest (a path,
    // "(*)"): no two parts can take the same characters, so a long odd line cannot make it slow.
    const m = /^([A-Za-z0-9_-]+) v(\d+\.\d+\.\d+(?:[-+]\S*)?)(?: (.*))?$/.exec(line.trim());
    if (!m || /\(\//.test(m[3] ?? '') || /\([A-Za-z]:\\/.test(m[3] ?? '')) continue;
    seen.set(`${m[1]}@${m[2]}`, { name: m[1]!, version: m[2]! });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const CVSS3 = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
} as const;

const roundUp = (x: number) => {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
};

/** The base score of a CVSS 3.0/3.1 vector (FIRST's formula), or null for anything else. */
export function cvss3Score(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const m = Object.fromEntries(
    vector
      .split('/')
      .slice(1)
      .map((kv) => kv.split(':') as [string, string]),
  );
  const changed = m.S === 'C';
  const av = CVSS3.AV[m.AV as keyof typeof CVSS3.AV];
  const ac = CVSS3.AC[m.AC as keyof typeof CVSS3.AC];
  const ui = CVSS3.UI[m.UI as keyof typeof CVSS3.UI];
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[
    m.PR as 'N' | 'L' | 'H'
  ];
  const [c, i, a] = [m.C, m.I, m.A].map((x) => CVSS3.CIA[x as keyof typeof CVSS3.CIA]);
  if ([av, ac, ui, pr, c, i, a].some((x) => x === undefined)) return null;
  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  return roundUp(
    changed
      ? Math.min(1.08 * (impact + exploitability), 10)
      : Math.min(impact + exploitability, 10),
  );
}

export function severityOfScore(score: number): Severity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'moderate';
  if (score > 0) return 'low';
  return 'unknown';
}

/** An OSV record, the fields we read. */
export interface OsvRecord {
  id: string;
  aliases?: string[];
  summary?: string;
  withdrawn?: string;
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string; informational?: string };
  affected?: {
    package?: { name?: string; ecosystem?: string };
    ranges?: { events?: { introduced?: string; fixed?: string }[] }[];
  }[];
}

/**
 * The severity of an OSV advisory: GitHub's rating when the record or a GHSA alias has one, else
 * its CVSS 3 base score, else unknown (CVSS 4 only, or none).
 */
export function osvSeverity(record: OsvRecord, aliasRecords: OsvRecord[] = []): Severity {
  for (const r of [record, ...aliasRecords]) {
    const s = r.database_specific?.severity?.toLowerCase();
    if (s && SEVERITIES.includes(s as Severity)) return s as Severity;
  }
  for (const r of [record, ...aliasRecords]) {
    for (const s of r.severity ?? []) {
      const score = cvss3Score(s.score);
      if (score !== null) return severityOfScore(score);
    }
  }
  return 'unknown';
}

/** One finding per crate version and advisory (aliases counted once, the GHSA id preferred). */
export function crateFindings(
  hits: { name: string; version: string; record: OsvRecord; aliases: OsvRecord[] }[],
): Finding[] {
  const out = new Map<string, Finding>();
  for (const { name, version, record, aliases } of hits) {
    if (record.withdrawn) continue;
    const ids = [record.id, ...(record.aliases ?? [])];
    const key = `${name}@${version}:${[...ids].sort().join(',')}`;
    const known = [...out.entries()].find(
      ([k, f]) => k.startsWith(`${name}@${version}:`) && ids.includes(f.id),
    );
    if (known) continue;
    const fixed = (record.affected ?? [])
      .filter((a) => a.package?.name === name)
      .flatMap((a) => a.ranges ?? [])
      .flatMap((r) => r.events ?? [])
      .flatMap((e) => (e.fixed ? [e.fixed] : []));
    out.set(key, {
      ecosystem: 'crates.io',
      package: name,
      version,
      id: ids.find((id) => id.startsWith('GHSA-')) ?? record.id,
      severity: osvSeverity(record, aliases),
      fixed: fixed.length ? `>=${fixed.join(' / ')}` : '—',
      shipped: true,
      parts: ['windows'],
      informational: Boolean(record.database_specific?.informational),
      title: record.summary ?? '',
    });
  }
  return [...out.values()];
}

// ------------------------------------------------------------------------------- the summary

const SEVERITY_AR: Record<Severity, string> = {
  critical: 'خطير',
  high: 'عالي',
  moderate: 'متوسط',
  low: 'قليل',
  unknown: 'غير محدد',
};
const PART_AR: Record<Part, string> = {
  server: 'السيرفر',
  screens: 'برنامج الشاشات',
  windows: 'جزء الويندوز',
};

const order = (f: Finding) => SEVERITIES.indexOf(f.severity);

/** The owner's short summary, in Arabic, as Markdown. */
export function summaryAr(findings: Finding[], date: string): string {
  const block = findings.filter(blocking).sort((a, b) => order(a) - order(b));
  const otherShipped = findings.filter((f) => f.shipped && !blocking(f));
  const notShipped = findings.filter((f) => !f.shipped);
  const lines = [`## فحص المكتبات الأسبوعي (${date})`, ''];
  if (block.length === 0) {
    lines.push(
      '**النتيجة: تمام.** مفيش تحذير خطير أو عالي في المكتبات اللي جوه البرنامج المتسطّب.',
    );
  } else {
    lines.push(
      `**النتيجة: محتاج تحديث.** فيه ${block.length} تحذير خطير أو عالي في مكتبات جوه البرنامج المتسطّب. قول لـ Claude يحدّثها.`,
      '',
      '| المكتبة | النسخة | الخطورة | التصليح في | فين |',
      '|---|---|---|---|---|',
      ...block.map(
        (f) =>
          `| ${f.package} | ${f.version} | ${SEVERITY_AR[f.severity]} | ${f.fixed} | ${f.parts.map((p) => PART_AR[p]).join('، ')} |`,
      ),
      '',
      ...block.map((f) => `- ${f.package}: ${f.id} — ${f.title}`),
    );
  }
  const count = (list: Finding[], s: Severity) => list.filter((f) => f.severity === s).length;
  lines.push(
    '',
    `- تحذيرات أقل جوه البرنامج (مش بتوقف حاجة): ${count(otherShipped, 'moderate')} متوسط، ${count(otherShipped, 'low')} قليل، ${otherShipped.filter((f) => f.informational || f.severity === 'unknown').length} ملاحظة.`,
    `- تحذيرات في أدوات التطوير والاختبارات بس (مش بتتسطّب): ${notShipped.length}.`,
  );
  return `${lines.join('\n')}\n`;
}
