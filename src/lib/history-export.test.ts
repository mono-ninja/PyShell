import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, csvEscape, historyFileName, historyToCsv, historyToJson } from "./history-export";
import type { HistoryEntry } from "../types/schema";

function entry(partial: Partial<HistoryEntry>): HistoryEntry {
  return {
    timestamp: "2026-09-05T10:00:00+03:00",
    job_id: "job-1",
    values: { target: "example.com" },
    exit_code: 0,
    duration_ms: 1500,
    ...partial,
  };
}

describe("csvEscape", () => {
  it("passes plain values through", () => {
    expect(csvEscape("2026-09-05T10:00:00+03:00")).toBe("2026-09-05T10:00:00+03:00");
  });

  it("quotes commas, quotes and newlines", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape("line\nbreak")).toBe('"line\nbreak"');
  });

  it("doubles embedded quotes", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });
});

describe("historyToCsv", () => {
  it("starts with the header and renders one row per entry in the given order", () => {
    const csv = historyToCsv([entry({ job_id: "b" }), entry({ job_id: "a" })]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines[1]).toContain("b");
    expect(lines[2]).toContain("a");
    expect(lines[3]).toBe(""); // trailing newline
  });

  it("embeds values as JSON and escapes them as one field", () => {
    const csv = historyToCsv([entry({ values: { q: "with,comma", n: 1 } })]);
    const line = csv.split("\n")[1];
    // Every inner quote doubles per CSV rules — including the ones around the
    // JSON keys — and the whole cell is wrapped in one pair of quotes.
    expect(line.endsWith(`,"{""q"":""with,comma"",""n"":1}"`)).toBe(true);
  });

  it("leaves empty cells for absent job ids and exit codes", () => {
    const csv = historyToCsv([entry({ job_id: null, exit_code: null })]);
    const cells = csv.split("\n")[1].split(",");
    // timestamp,job_id,exit_code,… — the absent ones are adjacent empty cells.
    expect(cells[1]).toBe("");
    expect(cells[2]).toBe("");
  });
});

describe("historyToJson", () => {
  it("round-trips through JSON.parse", () => {
    const entries = [entry({}), entry({ job_id: "job-2", exit_code: 1 })];
    expect(JSON.parse(historyToJson(entries))).toEqual(entries);
  });
});

describe("historyFileName", () => {
  it("names the file after the script", () => {
    expect(historyFileName("com.pyshell.x", "csv")).toBe("history-com.pyshell.x.csv");
  });

  it("strips path separators defensively", () => {
    expect(historyFileName("a/b\\c", "json")).toBe("history-a-b-c.json");
  });
});
