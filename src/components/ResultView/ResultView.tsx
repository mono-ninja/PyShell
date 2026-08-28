import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { save } from "@tauri-apps/plugin-dialog";
import { copyFile } from "@tauri-apps/plugin-fs";
import { FileIcon, SearchIcon, CloseIcon } from "../icons";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useToast } from "../Toast";
import { renderMarkdown, ExternalLink } from "../../lib/markdown";
import { SCRIPTS_URL } from "../../lib/links";
import { ChartView } from "../ChartView/ChartView";
import type { Artifact } from "../../types/schema";
import type { StructuredState } from "../../hooks/useJobs";

interface ResultViewProps {
  jobId: string | null;
  structured: StructuredState;
  artifacts: Artifact[];
  declaredResult?: "table" | "markdown" | "none" | null;
}

/**
 * The Results pane: the summary table a script emitted, plus the files it wrote.
 *
 * Progress and status are not here — they live in `RunStatusBar`, which stays
 * visible whichever tab is open. Artifacts are fetched by the parent rather than
 * here, so switching tabs cannot decide whether the fetch happens at all.
 */
export function ResultView({ jobId, structured, artifacts, declaredResult }: ResultViewProps) {
  const { notifyError } = useToast();
  const handleShowInFinder = useCallback((path: string) => {
    revealItemInDir(path).catch((e) => notifyError(e, "Reveal failed"));
  }, [notifyError]);

  // Binary copyFile — handles both text and binary artifacts (audit M14)
  const handleSaveAs = useCallback(async (path: string) => {
    try {
      const name = path.split(/[/\\]/).pop() ?? "artifact";
      const dest = await save({ defaultPath: name });
      if (dest) {
        await copyFile(path, dest);
      }
    } catch (e) {
      notifyError(e, "Save as failed");
    }
  }, [notifyError]);

  const table = structured.table;
  const markdown = structured.markdown;
  const chart = structured.chart;

  const [search, setSearch] = useState("");
  // Results content is fully replaced between runs, so a leftover filter would
  // hide everything with no visible reason — clear it when the job changes.
  useEffect(() => setSearch(""), [jobId]);

  const hasFilterable = (table != null && table.rows.length > 0) || artifacts.length > 0;

  const filteredRows = useMemo(() => {
    if (!table) return [];
    const rows = table.rows;
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      row.some((cell) =>
        (typeof cell === "object" ? JSON.stringify(cell) : String(cell)).toLowerCase().includes(q),
      ),
    );
  }, [table, search]);

  const filteredArtifacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return artifacts;
    return artifacts.filter((a) => a.name.toLowerCase().includes(q));
  }, [artifacts, search]);

  const totalFilterable = (table ? table.rows.length : 0) + artifacts.length;
  const shownFilterable = filteredRows.length + filteredArtifacts.length;
  const isFiltering = search.trim().length > 0 && shownFilterable < totalFilterable;

  if (!jobId || (!table && !markdown && !chart && artifacts.length === 0)) {
    // The declared kind only changes the wording — a script may emit anything
    // regardless of what its manifest says, so nothing here gates rendering.
    const hint = declaredResult === "markdown"
      ? <>This script declares a markdown result. Run it to see the output.</>
      : declaredResult === "table"
        ? <>This script declares a table result. Run it to see the output.</>
        : (
          <>
            Tables, charts, markdown and files a script produces show up here. See{" "}
            <ExternalLink href={SCRIPTS_URL}>
              PyShell-scripts
            </ExternalLink>{" "}
            for examples of how to emit them.
          </>
        );
    return (
      <div class="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 text-center">
        <p class="text-[13px] text-muted">No results yet</p>
        <p class="max-w-sm text-2xs leading-relaxed text-subtle">
          {hint}
        </p>
      </div>
    );
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      {hasFilterable && (
        <div class="flex shrink-0 items-center gap-2 border-b border-line px-5 py-2">
          <div class="relative min-w-0 flex-1">
            <SearchIcon size={13} class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              type="text"
              class="form-input w-full py-1 pl-7 pr-7 text-xs"
              aria-label="Search results"
              placeholder="Search table and files…"
              value={search}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
            />
            {search && (
              <button
                class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-fg"
                onClick={() => setSearch("")}
                title="Clear search"
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
          {isFiltering && (
            <span class="shrink-0 tabular-nums text-2xs text-subtle">
              {shownFilterable} / {totalFilterable}
            </span>
          )}
        </div>
      )}
      <div class="flex-1 space-y-4 overflow-y-auto px-5 py-4">
      {markdown && (
        <section class="space-y-1.5">
          <div class="flex items-baseline gap-2">
            <span class="panel-title">Result</span>
          </div>
          <div class="max-w-3xl text-[13px] text-fg">
            {renderMarkdown(markdown)}
          </div>
        </section>
      )}
      {chart && chart.series.length > 0 && (
        <section class="space-y-1.5">
          <div class="flex items-baseline gap-2">
            <span class="panel-title">Chart</span>
            <span class="text-2xs text-subtle">{chart.chartType}</span>
          </div>
          <div class="rounded-lg border border-line bg-surface px-3 py-2">
            <ChartView chart={chart} />
          </div>
        </section>
      )}
      {table && (
        <section class="space-y-1.5">
          <div class="flex items-baseline gap-2">
            <span class="panel-title">Table</span>
            <span class="text-2xs text-subtle">
              {search.trim() && filteredRows.length !== table.rows.length
                ? `${filteredRows.length} / ${table.rows.length} rows`
                : `${table.rows.length} ${table.rows.length === 1 ? "row" : "rows"}`}
            </span>
          </div>
          {filteredRows.length > 0 ? (
            <div class="overflow-x-auto rounded-lg border border-line">
              <table class="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    {table.columns.map((col) => (
                      <th
                        key={col}
                        class="sticky top-0 whitespace-nowrap border-b border-line bg-surface px-2.5 py-1.5 text-left font-semibold text-muted"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row, i) => (
                    <tr key={i} class="row-hover">
                      {row.map((cell, j) => (
                        <td key={j} class="border-b border-line/60 px-2.5 py-1.5 align-top">
                          {typeof cell === "object" ? JSON.stringify(cell) : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p class="rounded-lg border border-line bg-surface px-3 py-2 text-2xs text-subtle">
              No rows match "{search}".
            </p>
          )}
        </section>
      )}

      {filteredArtifacts.length > 0 && (
        <section class="space-y-1.5">
          <div class="flex items-baseline gap-2">
            <span class="panel-title">Artifacts</span>
            <span class="text-2xs text-subtle">
              {search.trim() && filteredArtifacts.length !== artifacts.length
                ? `${filteredArtifacts.length} / ${artifacts.length}`
                : artifacts.length}
            </span>
          </div>
          <div class="grid grid-cols-1 gap-1.5 lg:grid-cols-2">
            {filteredArtifacts.map((a) => (
              <div
                key={a.path}
                class="flex items-center gap-2 rounded-lg border border-line bg-raised px-2.5 py-1.5"
              >
                <FileIcon class="text-subtle" />
                <span class="min-w-0 flex-1 truncate text-[13px]" title={a.path}>
                  {a.name}
                </span>
                <span class="shrink-0 tabular-nums text-2xs text-subtle">
                  {formatSize(a.size_bytes)}
                </span>
                <button
                  type="button"
                  class="btn btn-ghost py-1"
                  onClick={() => handleShowInFinder(a.path)}
                >
                  Show
                </button>
                <button
                  type="button"
                  class="btn btn-secondary py-1"
                  onClick={() => handleSaveAs(a.path)}
                >
                  Save
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
