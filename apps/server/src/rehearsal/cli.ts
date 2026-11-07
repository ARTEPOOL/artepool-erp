/**
 * `pnpm acceptance:day` — the busy day (M7, decision 0119; PRD §12): four tills at once, 800+ POS
 * sales, 20,000 items, played through the real API on a throwaway database, then every check, a
 * backup restored and checked, and the speed against the targets. Red or slow → exit code 1.
 *
 *   pnpm acceptance:day            the busy day
 *   pnpm acceptance:day --shop     the shop's size (every case, about 150 sales)
 *   --summary <file>               also writes the Markdown table there (GitHub: the run summary)
 */
import { appendFile } from 'node:fs/promises';
import { loadEnv } from '@artepool/node-kit';
import { runRehearsal } from './run';
import { BUSY_DAY, SHOP_DAY } from './script';
import { summaryMarkdown } from './summary';

loadEnv();
const args = process.argv.slice(2);
const size = args.includes('--shop') ? SHOP_DAY : BUSY_DAY;
const at = args.indexOf('--summary');
const summaryFile = at >= 0 ? args[at + 1] : process.env.GITHUB_STEP_SUMMARY;

console.log(
  `Rehearsal (${size.name}): ${size.tills} tills × ${size.salesPerTill} sales, ${size.items} items`,
);
const report = await runRehearsal(size, {
  progress: (s) => {
    const detail = s.detail ? ` — ${s.detail}` : '';
    console.log(`${s.ok ? '✓' : '✗'} ${s.step} (${(s.ms / 1000).toFixed(1)} s)${detail}`);
  },
});
const markdown = summaryMarkdown(report);
console.log(`\n${markdown}`);
if (summaryFile) await appendFile(summaryFile, markdown);
process.exitCode = report.ok ? 0 : 1;
