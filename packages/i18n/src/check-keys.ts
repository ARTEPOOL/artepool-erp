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
  issue: 'missing' | 'empty' | 'placeholders' | 'not_text';
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
    for (const key of [...allKeys].sort()) {
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
