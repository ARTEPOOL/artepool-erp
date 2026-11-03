/**
 * The weekly dependency check's rules: what reaches the shipped app, how serious an advisory is,
 * and the owner's Arabic summary. Only critical or high advisories in shipped code fail it.
 */
import { describe, expect, it } from 'vitest';
import {
  blocking,
  crateFindings,
  cratesFromTree,
  cvss3Score,
  npmFindings,
  osvSeverity,
  summaryAr,
  type Finding,
  type OsvRecord,
} from '../../src/index';

const audit = {
  advisories: {
    '1': {
      module_name: 'zod',
      severity: 'high',
      github_advisory_id: 'GHSA-mrhx-c7xc-m3w5',
      patched_versions: '>=4.6.6',
      title: 'Zod can exhaust memory',
      findings: [{ version: '4.6.5', paths: ['apps__server>zod', 'packages__shared>zod'] }],
    },
    '2': {
      module_name: 'undici',
      severity: 'high',
      github_advisory_id: 'GHSA-xjj6-f33q-929c',
      patched_versions: '>=8.12.2',
      title: 'undici DoS',
      findings: [{ version: '8.10.0', paths: ['apps__desktop>jsdom>undici'] }],
    },
    '3': {
      module_name: 'minimatch',
      severity: 'moderate',
      github_advisory_id: 'GHSA-g3hv-75wg-m249',
      patched_versions: '>=11.0.1',
      title: 'minimatch DoS',
      findings: [
        { version: '10.2.5', paths: ['.>eslint>minimatch', 'tools__release>x>minimatch'] },
      ],
    },
  },
};

describe('JavaScript advisories', () => {
  it('count as shipped only through the server, the screens or the shared packages', () => {
    const [zod, undici, minimatch] = npmFindings(audit);
    expect(zod).toMatchObject({ shipped: true, parts: ['screens', 'server'], severity: 'high' });
    // `pnpm audit --prod` would not list jsdom at all; if it did, the path still says screens.
    expect(undici?.shipped).toBe(true);
    expect(minimatch).toMatchObject({ shipped: false, parts: [], severity: 'moderate' });
    expect(blocking(zod!)).toBe(true);
    expect(blocking(minimatch!)).toBe(false);
  });

  it('reads an empty or odd report as nothing', () => {
    expect(npmFindings({})).toEqual([]);
    expect(npmFindings(null)).toEqual([]);
  });
});

describe('the Windows programs’ crates', () => {
  it('are read from cargo tree, without our own crates and once each', () => {
    const tree = [
      'artepool-desktop v0.1.0 (/home/u/artepool-erp/apps/desktop/src-tauri)',
      'tauri v2.12.1',
      'zip v9.0.5',
      'zip v9.0.5',
      'artepool-svc v0.1.0 (C:\\a\\svc)',
      'windows-sys v0.61.2',
      '',
    ].join('\n');
    expect(cratesFromTree(tree)).toEqual([
      { name: 'tauri', version: '2.12.1' },
      { name: 'windows-sys', version: '0.61.2' },
      { name: 'zip', version: '9.0.5' },
    ]);
  });

  it('read a pre-release version and a "(*)" mark, and stay fast on a long odd line', () => {
    expect(cratesFromTree('ring v0.17.14-rc.1 (*)\nserde v1.0.228')).toEqual([
      { name: 'ring', version: '0.17.14-rc.1' },
      { name: 'serde', version: '1.0.228' },
    ]);
    // A line that cannot match (a line separator inside it) is where a slow pattern backtracks.
    const odd = [
      `- v0.0.0${'!'.repeat(50_000)}\u2028x`,
      `- v0.0.0${'0'.repeat(50_000)}\u2028x`,
      `- v0.0.0-${'0'.repeat(50_000)}\u2028x`,
    ].join('\n');
    const started = performance.now();
    expect(cratesFromTree(odd)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('CVSS 3 base scores (FIRST’s examples)', () => {
  it('match the published scores', () => {
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H')).toBe(7.5);
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1);
    expect(cvss3Score('CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:H/I:N/A:N')).toBe(4); // worked by hand: 3.595 + 0.333
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N')).toBe(0);
  });

  it('are not guessed for CVSS 4 or a broken vector', () => {
    expect(cvss3Score('CVSS:4.0/AV:N/AC:H/AT:N/PR:L/UI:A/VC:N/VI:N/VA:H')).toBeNull();
    expect(cvss3Score('CVSS:3.1/AV:X')).toBeNull();
  });
});

const zipCritical: OsvRecord = {
  id: 'GHSA-m665-v7pm-7grj',
  aliases: ['CVE-2026-115905'],
  summary: 'zip: parser differential',
  database_specific: { severity: 'CRITICAL' },
  affected: [
    { package: { name: 'zip' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '9.0.5' }] }] },
  ],
};
const rustsecWithGhsa: OsvRecord = {
  id: 'RUSTSEC-2026-0429',
  aliases: ['GHSA-q7v9-x93c-xqv3'],
  summary: 'zip: aborts on a symlink entry',
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' }],
  affected: [{ package: { name: 'zip' }, ranges: [{ events: [{ fixed: '9.0.0' }] }] }],
};
const ghsaOfIt: OsvRecord = {
  id: 'GHSA-q7v9-x93c-xqv3',
  aliases: ['RUSTSEC-2026-0429'],
  database_specific: { severity: 'HIGH' },
};
const unmaintained: OsvRecord = {
  id: 'RUSTSEC-2024-0370',
  summary: 'proc-macro-error is unmaintained',
  database_specific: { informational: 'unmaintained' },
};

describe('Rust advisories', () => {
  it('take GitHub’s rating, else the CVSS 3 score, else unknown', () => {
    expect(osvSeverity(zipCritical)).toBe('critical');
    expect(osvSeverity(rustsecWithGhsa, [ghsaOfIt])).toBe('high');
    expect(osvSeverity(rustsecWithGhsa)).toBe('high'); // 7.5 from its vector
    expect(osvSeverity({ id: 'X', severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N' }] })).toBe(
      'unknown',
    );
  });

  it('count an advisory and its aliases once, with the GHSA id and the fixed version', () => {
    const found = crateFindings([
      { name: 'zip', version: '4.6.1', record: zipCritical, aliases: [] },
      { name: 'zip', version: '4.6.1', record: rustsecWithGhsa, aliases: [ghsaOfIt] },
      { name: 'zip', version: '4.6.1', record: ghsaOfIt, aliases: [] },
      {
        name: 'zip',
        version: '4.6.1',
        record: { ...zipCritical, id: 'W', withdrawn: '2026' },
        aliases: [],
      },
    ]);
    expect(found.map((f) => [f.id, f.severity, f.fixed])).toEqual([
      ['GHSA-m665-v7pm-7grj', 'critical', '>=9.0.5'],
      ['GHSA-q7v9-x93c-xqv3', 'high', '>=9.0.0'],
    ]);
    expect(found.every((f) => f.shipped && f.parts.join() === 'windows')).toBe(true);
  });

  it('never fail on an "unmaintained" or "unsound" note', () => {
    const [note] = crateFindings([
      { name: 'proc-macro-error', version: '1.0.4', record: unmaintained, aliases: [] },
    ]);
    expect(note).toMatchObject({ informational: true, severity: 'unknown' });
    expect(blocking(note!)).toBe(false);
  });
});

describe('the owner’s summary', () => {
  const base: Finding = {
    ecosystem: 'npm',
    package: 'zod',
    version: '4.6.5',
    id: 'GHSA-mrhx-c7xc-m3w5',
    severity: 'high',
    fixed: '>=4.6.6',
    shipped: true,
    parts: ['server'],
    informational: false,
    title: 'Zod can exhaust memory',
  };

  it('says all is well when nothing serious reaches the app', () => {
    const text = summaryAr(
      [
        { ...base, severity: 'moderate' },
        { ...base, package: 'undici', shipped: false, parts: [] },
      ],
      '2026-11-09',
    );
    expect(text).toContain('**النتيجة: تمام.**');
    expect(text).toContain('1 متوسط');
    expect(text).toContain('أدوات التطوير والاختبارات بس (مش بتتسطّب): 1');
  });

  it('lists what needs updating, worst first, with where it is', () => {
    const text = summaryAr(
      [
        base,
        {
          ...base,
          ecosystem: 'crates.io',
          package: 'zip',
          version: '4.6.1',
          severity: 'critical',
          fixed: '>=9.0.5',
          parts: ['windows'],
        },
      ],
      '2026-11-09',
    );
    expect(text).toContain('**النتيجة: محتاج تحديث.** فيه 2 تحذير');
    expect(text.indexOf('| zip |')).toBeLessThan(text.indexOf('| zod |'));
    expect(text).toContain('| zip | 4.6.1 | خطير | >=9.0.5 | جزء الويندوز |');
    expect(text).toContain('| zod | 4.6.5 | عالي | >=4.6.6 | السيرفر |');
  });
});
