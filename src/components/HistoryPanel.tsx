import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { HistoryEntry } from "../types/schema";
import { useToast } from "./Toast";
import { useI18n } from "../lib/i18n";
import { Modal } from "./Modal";
import { ContextMenu } from "./ContextMenu";
import { historyFileName, historyToCsv, historyToJson } from "../lib/history-export";
import { CheckIcon, CloseIcon, DownloadIcon, SearchIcon } from "./icons";

interface HistoryPanelProps {
  scriptId: string;
  /** Chronological (oldest first), as stored. The panel reverses for display. */
  history: HistoryEntry[];
  /** A job of this script is running — Retry is disabled meanwhile. */
  running: boolean;
  onRetry: (entry: HistoryEntry) => void;
  onOpenPastRun: (jobId: string, kind: "log" | "files") => void;
}

/** Lowercased haystack for history search: visible columns plus the run's
 *  input values, so "find the run where I set target=x" works. */
function historyHaystack(entry: HistoryEntry): string {
  return [
    new Date(entry.timestamp).toLocaleString(),
    entry.exit_code === 0 ? "succeeded" : "failed",
    `exit ${entry.exit_code ?? "—"}`,
    `${(entry.duration_ms / 1000).toFixed(1)}s`,
    JSON.stringify(entry.values),
  ].join("\n").toLowerCase();
}

/**
 * Stable identity of a history entry across refetches: the job id when there
 * is one, timestamp+duration for entries that predate `job_id`. Comparing by
 * identity (plan P2-3) instead of list index keeps the *first* pick correct
 * even when another run of the same script finishes between the two clicks
 * and shifts every index.
 */
export function historyKey(entry: HistoryEntry): string {
  return entry.job_id ?? `${entry.timestamp}|${entry.duration_ms}`;
}

/**
 * The History tab: searchable list of past runs with Log/Files/Compare/Retry,
 * run-value comparison, and CSV/JSON export.
 *
 * Search, the compare selection and the compare dialog live here — they are
 * all history-scoped state. Retry and opening a past run's files stay with the
 * caller, which owns jobs and the selected script.
 */
export function HistoryPanel({ scriptId, history, running, onRetry, onOpenPastRun }: HistoryPanelProps) {
  const { t } = useI18n();
  const { notify, notifyError } = useToast();
  const [search, setSearch] = useState("");
  const [compareBaseKey, setCompareBaseKey] = useState<string | null>(null);
  const [compareDiff, setCompareDiff] = useState<{ base: HistoryEntry; target: HistoryEntry } | null>(null);
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null);

  // A new script starts with a clean search and no compare selection.
  useEffect(() => {
    setSearch("");
    setCompareBaseKey(null);
  }, [scriptId]);

  const reversed = useMemo(() => history.slice().reverse(), [history]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return reversed;
    return reversed.filter((entry) => historyHaystack(entry).includes(q));
  }, [reversed, search]);

  const handleCompare = useCallback(
    (entry: HistoryEntry) => {
      const key = historyKey(entry);
      if (compareBaseKey === null) {
        setCompareBaseKey(key);
      } else if (compareBaseKey === key) {
        setCompareBaseKey(null);
      } else {
        // Resolve the first pick by identity, not position: if another run
        // finished between the clicks, indexes shifted but the key did not.
        const base = history.find((h) => historyKey(h) === compareBaseKey);
        if (base) setCompareDiff({ base, target: entry });
        setCompareBaseKey(null);
      }
    },
    [compareBaseKey, history],
  );

  const handleExport = useCallback(
    async (format: "csv" | "json") => {
      setExportMenu(null);
      try {
        const dest = await save({
          defaultPath: historyFileName(scriptId, format),
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (!dest) return;
        // What you see is what you export: the current filter applies.
        const content = format === "csv" ? historyToCsv(visible) : historyToJson(visible);
        await writeTextFile(dest, content);
        notify("info", t("Exported {n} runs", { n: visible.length }));
      } catch (e) {
        notifyError(e, t("Export failed"));
      }
    },
    [scriptId, visible, notify, notifyError, t],
  );

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      {history.length > 0 && (
        <div class="flex shrink-0 items-center gap-2 border-b border-line px-5 py-2">
          <div class="relative min-w-0 flex-1">
            <SearchIcon size={13} class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              type="text"
              class="form-input w-full py-1 pl-7 pr-7 text-xs"
              aria-label={t("Search history")}
              placeholder={t("Search runs…")}
              value={search}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
            />
            {search && (
              <button
                class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-fg"
                onClick={() => setSearch("")}
                title={t("Clear search")}
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
          {search.trim() && visible.length !== history.length && (
            <span class="shrink-0 tabular-nums text-2xs text-subtle">
              {visible.length} / {history.length}
            </span>
          )}
          <button
            type="button"
            class="btn btn-secondary shrink-0 py-1"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setExportMenu({ x: r.left, y: r.bottom + 4 });
            }}
            title={t("Export history…")}
          >
            <DownloadIcon size={13} />
            {t("Export")}
          </button>
        </div>
      )}
      <div class="flex-1 overflow-y-auto px-5 py-3">
        {history.length === 0 ? (
          <div class="flex h-full items-center justify-center text-center">
            <p class="text-[13px] text-muted">{t("No runs yet.")}</p>
          </div>
        ) : visible.length === 0 ? (
          <div class="flex h-full items-center justify-center text-center">
            <p class="text-[13px] text-muted">{t("No runs match \"{q}\".", { q: search })}</p>
          </div>
        ) : (
          <div class="flex flex-col">
            {visible.map((entry, idx) => {
              const key = historyKey(entry);
              const picked = compareBaseKey === key;
              return (
                <div
                  key={entry.job_id ?? `${entry.timestamp}-${entry.duration_ms}-${idx}`}
                  class="row-hover group -mx-1.5 flex items-center gap-3 rounded px-1.5 py-1.5 text-2xs"
                >
                  <span
                    class={`shrink-0 ${entry.exit_code === 0 ? "text-ok" : "text-danger"}`}
                    title={entry.exit_code === 0 ? t("Succeeded") : t("Failed")}
                    aria-label={entry.exit_code === 0 ? t("Succeeded") : t("Failed")}
                  >
                    {entry.exit_code === 0 ? <CheckIcon size={12} /> : <CloseIcon size={12} />}
                  </span>
                  <span class="tabular-nums text-muted">
                    {new Date(entry.timestamp).toLocaleString()}
                  </span>
                  <span
                    class={`tabular-nums ${
                      entry.exit_code === 0 ? "text-ok" : "text-danger"
                    }`}
                  >
                    {t("exit {code}", { code: entry.exit_code ?? "—" })}
                  </span>
                  <span class="tabular-nums text-subtle">
                    {(entry.duration_ms / 1000).toFixed(1)}s
                  </span>
                  <div class="ml-auto flex items-center gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    {entry.job_id && (
                      <>
                        <button
                          class="text-subtle hover:text-fg disabled:opacity-30"
                          onClick={() => onOpenPastRun(entry.job_id!, "log")}
                          title={t("Reveal this run's log in Finder")}
                        >
                          {t("Log")}
                        </button>
                        <button
                          class="text-subtle hover:text-fg disabled:opacity-30"
                          onClick={() => onOpenPastRun(entry.job_id!, "files")}
                          title={t("Open this run's output folder")}
                        >
                          {t("Files")}
                        </button>
                      </>
                    )}
                    <button
                      class={`hover:underline disabled:opacity-30 ${
                        picked ? "text-accent font-medium" : "text-subtle hover:text-fg"
                      }`}
                      onClick={() => handleCompare(entry)}
                      title={
                        compareBaseKey === null
                          ? t("Select for comparison")
                          : picked
                            ? t("Cancel comparison")
                            : t("Compare with this run")
                      }
                    >
                      {picked ? t("Cancel") : t("Compare")}
                    </button>
                    <button
                      class="text-accent hover:underline disabled:opacity-30"
                      onClick={() => onRetry(entry)}
                      disabled={running}
                      title={t("Re-run with these values")}
                    >
                      {t("Retry")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {exportMenu && (
        <ContextMenu
          x={exportMenu.x}
          y={exportMenu.y}
          items={[
            { label: t("Export history as CSV"), onSelect: () => handleExport("csv") },
            { label: t("Export history as JSON"), onSelect: () => handleExport("json") },
          ]}
          onClose={() => setExportMenu(null)}
        />
      )}

      {/* Run comparison (Plan.md §2.2) */}
      {compareDiff && (
        <Modal onClose={() => setCompareDiff(null)} title={t("Run comparison")} panelClass="max-w-2xl max-h-[80vh] overflow-y-auto">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-[15px] font-semibold">{t("Run comparison")}</h2>
            <button class="btn btn-secondary" onClick={() => setCompareDiff(null)}>{t("Close")}</button>
          </div>
          <div class="mb-4 flex gap-6 text-2xs text-subtle">
            <div>
              <span class="font-medium text-muted">{t("Base:")}</span>{" "}
              {new Date(compareDiff.base.timestamp).toLocaleString()} · {t("exit {code}", { code: compareDiff.base.exit_code ?? "—" })}
            </div>
            <div>
              <span class="font-medium text-muted">{t("Target:")}</span>{" "}
              {new Date(compareDiff.target.timestamp).toLocaleString()} · {t("exit {code}", { code: compareDiff.target.exit_code ?? "—" })}
            </div>
          </div>
          <div class="space-y-1.5">
            {(() => {
              const allKeys = new Set([
                ...Object.keys(compareDiff.base.values),
                ...Object.keys(compareDiff.target.values),
              ]);
              const rows = Array.from(allKeys).sort().map((key) => {
                const baseVal = compareDiff.base.values[key];
                const targetVal = compareDiff.target.values[key];
                const changed = JSON.stringify(baseVal) !== JSON.stringify(targetVal);
                return { key, baseVal, targetVal, changed };
              });
              const changedCount = rows.filter((r) => r.changed).length;
              if (changedCount === 0) {
                return <p class="text-[13px] text-muted">{t("No differences — both runs used the same values.")}</p>;
              }
              return (
                <>
                  <p class="mb-2 text-2xs text-subtle">{t("{n} fields changed", { n: changedCount })}</p>
                  {rows.filter((r) => r.changed).map((r) => (
                    <div key={r.key} class="grid grid-cols-[120px_1fr_1fr] gap-2 rounded-lg border border-line px-3 py-2 text-xs">
                      <span class="font-mono text-muted">{r.key}</span>
                      <span class="font-mono text-danger line-through opacity-70">
                        {r.baseVal === undefined ? "—" : typeof r.baseVal === "object" ? JSON.stringify(r.baseVal) : String(r.baseVal)}
                      </span>
                      <span class="font-mono text-ok">
                        {r.targetVal === undefined ? "—" : typeof r.targetVal === "object" ? JSON.stringify(r.targetVal) : String(r.targetVal)}
                      </span>
                    </div>
                  ))}
                </>
              );
            })()}
          </div>
        </Modal>
      )}
    </div>
  );
}
