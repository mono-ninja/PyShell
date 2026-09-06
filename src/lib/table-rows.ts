/**
 * Table-event row normalization.
 *
 * The Results pane renders each row with `row.map((cell, j) => …)`, so a row
 * must be an array of cells aligned with `columns` — the shape every example
 * in the scripting guide shows. Scripts written before that was spelled out
 * sometimes emit rows as `{column: cell}` objects; those crashed the whole
 * Results pane with `TypeError: row.map is not a function` (the table, the
 * markdown and the artifact list all live in the same component).
 *
 * Normalize here instead of trusting the wire: an array row passes through
 * untouched, any other row is read as a column→cell map (missing cells become
 * ""), and a `rows` that is not an array at all becomes an empty table. Old
 * scripts keep rendering; new ones should still send arrays.
 */
export function normalizeTableRows(
  columns: string[],
  rows: unknown[] | undefined,
): unknown[][] {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) =>
    Array.isArray(row)
      ? row
      : columns.map((c) => {
          const cell = (row as Record<string, unknown> | null)?.[c];
          return cell === undefined || cell === null ? "" : cell;
        }),
  );
}
