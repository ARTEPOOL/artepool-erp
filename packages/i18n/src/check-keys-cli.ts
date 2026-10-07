/** `pnpm i18n:check` — fails if any text is missing, empty or has different placeholders. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_CODES } from '@artepool/shared/errors';
import { checkLocales, type LocaleTree, type Messages } from './check-keys';

const localesDir = join(import.meta.dirname, '..', 'locales');
const tree: LocaleTree = {};
for (const language of readdirSync(localesDir)) {
  tree[language] = {};
  for (const file of readdirSync(join(localesDir, language)).filter((f) => f.endsWith('.json'))) {
    tree[language][file.replace(/\.json$/, '')] = JSON.parse(
      readFileSync(join(localesDir, language, file), 'utf8'),
    ) as Messages;
  }
}

const problems = checkLocales(tree, { common: ERROR_CODES.map((code) => `errors.${code}`) });
if (problems.length === 0) {
  console.log(`i18n OK: ${Object.keys(tree).join(', ')} have the same texts and placeholders.`);
} else {
  for (const p of problems) {
    console.error(
      `[${p.language}] ${p.namespace}:${p.key} — ${p.issue}${p.detail ? ` (${p.detail})` : ''}`,
    );
  }
  console.error(`i18n check failed: ${problems.length} problem(s).`);
  process.exit(1);
}
