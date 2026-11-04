/**
 * `pnpm deps:check`: the weekly dependency check (see index.ts). Writes the Arabic summary to the
 * job's summary (GITHUB_STEP_SUMMARY), to `deps-check-summary.md` and to the console, and exits 1
 * when a critical or high advisory reaches the shipped app, or when the check could not run (a
 * check that did not run must not look like a pass).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '@artepool/node-kit';
import {
  blocking,
  crateFindings,
  cratesFromTree,
  npmFindings,
  summaryAr,
  type Finding,
  type OsvRecord,
} from './index';

const OSV = 'https://api.osv.dev/v1';
const TAURI_DIR = join(repoRoot, 'apps', 'desktop', 'src-tauri');
/** The programs installed on the shop's PCs. */
const SHIPPED_CRATES = ['artepool-desktop', 'artepool-svc', 'artepool-emergency'];

function npmAudit(): Finding[] {
  // pnpm exits 1 when it finds anything; the JSON is still complete on stdout.
  const run = spawnSync('pnpm', ['audit', '--json', '--prod'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  let audit: unknown;
  try {
    audit = JSON.parse(run.stdout);
  } catch {
    throw new Error(`pnpm audit gave no report: ${run.stderr.slice(0, 500)}`);
  }
  if ((audit as { error?: unknown }).error) {
    throw new Error(`pnpm audit failed: ${JSON.stringify((audit as { error: unknown }).error)}`);
  }
  return npmFindings(audit);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return (await r.json()) as T;
}

const records = new Map<string, Promise<OsvRecord | null>>();
function record(id: string): Promise<OsvRecord | null> {
  let r = records.get(id);
  if (!r) {
    r = fetch(`${OSV}/vulns/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(60_000),
    }).then(async (res) => (res.ok ? ((await res.json()) as OsvRecord) : null));
    records.set(id, r);
  }
  return r;
}

async function crateAudit(): Promise<Finding[]> {
  const tree = execFileSync(
    'cargo',
    [
      'tree',
      // The versions in Cargo.lock, exactly as the installers are built.
      '--locked',
      '--target',
      'x86_64-pc-windows-msvc',
      '-e',
      'normal,no-proc-macro',
      '--prefix',
      'none',
      ...SHIPPED_CRATES.flatMap((c) => ['-p', c]),
    ],
    { cwd: TAURI_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const crates = cratesFromTree(tree);
  if (crates.length < 50) throw new Error(`cargo tree listed only ${crates.length} crates`);
  const hits: { name: string; version: string; record: OsvRecord; aliases: OsvRecord[] }[] = [];
  for (let i = 0; i < crates.length; i += 500) {
    const batch = crates.slice(i, i + 500);
    const { results } = await postJson<{ results: { vulns?: { id: string }[] }[] }>(
      `${OSV}/querybatch`,
      {
        queries: batch.map((c) => ({
          package: { name: c.name, ecosystem: 'crates.io' },
          version: c.version,
        })),
      },
    );
    for (const [j, result] of results.entries()) {
      for (const v of result.vulns ?? []) {
        const full = await record(v.id);
        if (!full) throw new Error(`OSV has no record for ${v.id}`);
        const aliases = (
          await Promise.all(
            (full.aliases ?? []).filter((a) => a.startsWith('GHSA-')).map((a) => record(a)),
          )
        ).filter((a): a is OsvRecord => a !== null);
        hits.push({ ...batch[j]!, record: full, aliases });
      }
    }
  }
  return crateFindings(hits);
}

async function main(): Promise<number> {
  const date = new Date().toISOString().slice(0, 10);
  let summary: string;
  let failed: boolean;
  try {
    const findings = [...npmAudit(), ...(await crateAudit())];
    summary = summaryAr(findings, date);
    failed = findings.some(blocking);
    for (const f of findings) {
      console.log(
        `${blocking(f) ? 'BLOCKING ' : ''}[${f.severity}${f.informational ? ', note' : ''}] ${f.ecosystem} ${f.package}@${f.version} ${f.id} shipped=${f.shipped} fixed=${f.fixed}`,
      );
    }
  } catch (error) {
    summary = `## فحص المكتبات الأسبوعي (${date})\n\n**الفحص ما كملش:** ${error instanceof Error ? error.message : String(error)}\n\nده عطل في الفحص نفسه (غالبًا النت)، مش في البرنامج. هيتجرّب تاني الأسبوع الجاي، أو شغّله بإيدك من Actions.\n`;
    failed = true;
  }
  console.log(`\n${summary}`);
  writeFileSync(join(repoRoot, 'deps-check-summary.md'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  return failed ? 1 : 0;
}

process.exitCode = await main();
