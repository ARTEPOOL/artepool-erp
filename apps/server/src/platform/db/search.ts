/**
 * Searching names the way people type them: every word must appear somewhere in the search key,
 * in any order ("كلور شمس" finds "شمس كلور 5 كغ"), with Arabic letter forms and digits unified by
 * sys.normalize_search. % and _ are taken as plain characters.
 */
import { sql, type RawBuilder } from 'kysely';

export function matchesWords(column: string, text: string): RawBuilder<boolean> {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length === 0) return sql<boolean>`true`;
  return sql<boolean>`(${sql.join(
    words.map(
      (w) =>
        sql`${sql.ref(column)} LIKE '%' || replace(replace(replace(sys.normalize_search(${w}), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`,
    ),
    sql` AND `,
  )})`;
}
