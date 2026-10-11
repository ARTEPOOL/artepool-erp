/** Translation completeness checks: every key in every language, same placeholders, no empty text. */

export interface Messages {
  [key: string]: string | Messages;
}

/** language → namespace → messages */
export type LocaleTree = Record<string, Record<string, Messages>>;

export interface Problem {
  language: string;
  namespace: string;
  key: string;
  issue: 'missing' | 'empty' | 'placeholders' | 'not_text' | 'plural_form';
  detail?: string;
}

export function flattenMessages(messages: Messages, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of flattenMessages(value, path)) out.set(k, v);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

/** Placeholder names used in a message, e.g. "Hello {name}" → ["name"]. */
export function placeholdersOf(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names].sort();
}

const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
const PLURAL_KEY = new RegExp(`^(.+)_(${PLURAL_FORMS.join('|')})$`);

/**
 * The plural forms a language needs, from the Unicode rules i18next also uses: English needs
 * `one` and `other`; Arabic needs all six (`zero`, `one`, `two`, `few` for 3–10, `many` for
 * 11–99, `other`). i18next does not fall back from a missing form, so a gap shows the raw key.
 */
export function pluralFormsOf(language: string): string[] {
  const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
  return PLURAL_FORMS.filter((form) => categories.includes(form));
}

/** `base_one` → `base` when the key is a plural form (its group has an `_other`). */
function pluralBaseOf(key: string, allKeys: ReadonlySet<string>): string | null {
  const match = PLURAL_KEY.exec(key);
  return match?.[1] !== undefined && allKeys.has(`${match[1]}_other`) ? match[1] : null;
}

export function checkLocales(
  tree: LocaleTree,
  required: Record<string, readonly string[]> = {},
): Problem[] {
  const problems: Problem[] = [];
  const languages = Object.keys(tree);
  const namespaces = new Set([
    ...languages.flatMap((l) => Object.keys(tree[l] ?? {})),
    ...Object.keys(required),
  ]);

  for (const namespace of namespaces) {
    const flat = new Map(
      languages.map((l) => [l, flattenMessages(tree[l]?.[namespace] ?? {})] as const),
    );
    const allKeys = new Set([
      ...[...flat.values()].flatMap((m) => [...m.keys()]),
      ...(required[namespace] ?? []),
    ]);
    const plurals = new Set<string>();
    for (const key of allKeys) {
      const base = pluralBaseOf(key, allKeys);
      if (base !== null) plurals.add(base);
    }
    for (const base of [...plurals].sort()) {
      problems.push(...checkPlural(languages, flat, namespace, base));
    }

    for (const key of [...allKeys].sort()) {
      if (pluralBaseOf(key, allKeys) !== null) continue;
      const texts = new Map<string, string>();
      for (const language of languages) {
        const value = flat.get(language)?.get(key);
        if (value === undefined) {
          problems.push({ language, namespace, key, issue: 'missing' });
        } else if (typeof value !== 'string') {
          problems.push({ language, namespace, key, issue: 'not_text' });
        } else if (value.trim() === '') {
          problems.push({ language, namespace, key, issue: 'empty' });
        } else {
          texts.set(language, value);
        }
      }
      const signatures = new Map(
        [...texts].map(([language, text]) => [language, placeholdersOf(text).join(',')]),
      );
      if (new Set(signatures.values()).size > 1) {
        for (const [language, signature] of signatures) {
          problems.push({
            language,
            namespace,
            key,
            issue: 'placeholders',
            detail: signature || '(none)',
          });
        }
      }
    }
  }
  return problems;
}

/**
 * A plural group: each language has exactly the forms its grammar needs, none empty, and every
 * form uses the same placeholders — except `count`, which a form may leave out ("صف واحد").
 */
function checkPlural(
  languages: readonly string[],
  flat: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
  namespace: string,
  base: string,
): Problem[] {
  const problems: Problem[] = [];
  const signatures = new Map<string, string>();
  for (const language of languages) {
    const messages = flat.get(language);
    const needed = pluralFormsOf(language);
    for (const form of PLURAL_FORMS) {
      const key = `${base}_${form}`;
      const value = messages?.get(key);
      if (!needed.includes(form)) {
        if (value !== undefined) {
          problems.push({ language, namespace, key, issue: 'plural_form', detail: 'not used' });
        }
      } else if (value === undefined) {
        problems.push({ language, namespace, key, issue: 'missing' });
      } else if (typeof value !== 'string') {
        problems.push({ language, namespace, key, issue: 'not_text' });
      } else if (value.trim() === '') {
        problems.push({ language, namespace, key, issue: 'empty' });
      } else {
        signatures.set(
          `${language}:${key}`,
          placeholdersOf(value)
            .filter((name) => name !== 'count')
            .join(','),
        );
      }
    }
  }
  if (new Set(signatures.values()).size > 1) {
    for (const [where, signature] of signatures) {
      const [language = '', key = ''] = where.split(':');
      problems.push({
        language,
        namespace,
        key,
        issue: 'placeholders',
        detail: signature || '(none)',
      });
    }
  }
  return problems;
}
