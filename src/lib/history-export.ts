import type { HistoryEntry } from "../types/schema";

/**
 * History export (plan 3-5): the run list of a measuring script is data, not
 * a journal — it leaves the app as CSV (spreadsheets) or JSON (everything
 * else). Pure functions so the escaping rules are testable.
 */

/** Quote a CSV field: wrap it when it contains a comma, quote or newline;
 * double any embedded quotes. */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** The columns every export carries, in order. */
export const CSV_COLUMNS = ["timestamp", "job_id", "exit_code", "duration_ms", "values"] as const;

/** Render history entries as CSV. `values` is embedded as JSON — arbitrary
 * form data has no honest scalar form, and JSON-in-a-cell pastes cleanly into
 * spreadsheet formula bars. */
export function historyToCsv(entries: HistoryEntry[]): string {
  const rows = entries.map((e) =>
    [
      e.timestamp,
      e.job_id ?? "",
      e.exit_code === null || e.exit_code === undefined ? "" : String(e.exit_code),
      String(e.duration_ms),
      JSON.stringify(e.values),
    ]
      .map(csvEscape)
      .join(","),
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}

/** Render history entries as pretty-printed JSON — the entries exactly as
 * PyShell stores them, no lossy flattening. */
export function historyToJson(entries: HistoryEntry[]): string {
  return JSON.stringify(entries, null, 2) + "\n";
}

/** Suggested file stem for an export: `history-<scriptId>.<ext>`. */
export function historyFileName(scriptId: string, ext: "csv" | "json"): string {
  // Script ids are manifest-authored (`com.pyshell.x`); a `/` would only hurt
  // on the save dialog's suggestion, so strip path separators defensively.
  const safe = scriptId.replace(/[/\\]/g, "-");
  return `history-${safe}.${ext}`;
}
