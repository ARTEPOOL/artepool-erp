/**
 * Rows with a `parentId` in tree order: each parent followed by its children (sorted), with the
 * depth for indentation. A row whose parent is missing is shown at the top level.
 */
export function treeOrder<T extends { id: string; parentId: string | null }>(
  rows: readonly T[],
  compare: (a: T, b: T) => number,
): { row: T; depth: number }[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string | null, T[]>();
  for (const row of rows) {
    const parent = row.parentId !== null && ids.has(row.parentId) ? row.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const out: { row: T; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | null, depth: number) => {
    for (const row of [...(children.get(parent) ?? [])].sort(compare)) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ row, depth });
      visit(row.id, depth + 1);
    }
  };
  visit(null, 0);
  // A loop the server would refuse anyway: still show every row.
  for (const row of rows) if (!seen.has(row.id)) out.push({ row, depth: 0 });
  return out;
}

/** The ids of a row and everything under it (a row cannot move under its own branch). */
export function branchOf<T extends { id: string; parentId: string | null }>(
  rows: readonly T[],
  id: string,
): Set<string> {
  const branch = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.parentId !== null && branch.has(row.parentId) && !branch.has(row.id)) {
        branch.add(row.id);
        grew = true;
      }
    }
  }
  return branch;
}

/** An indented label for a choice in a native select (which cannot be styled per option). */
export const indent = (depth: number, label: string): string => `${' '.repeat(depth)}${label}`;
