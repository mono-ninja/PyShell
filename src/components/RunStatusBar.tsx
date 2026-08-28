import type { JobEvent } from "../types/schema";
import type { StructuredState } from "../hooks/useJobs";

interface RunStatusBarProps {
  running: boolean;
  structured: StructuredState;
  exitInfo: JobEvent | null;
}

/**
 * Thin always-visible strip for progress and status.
 *
 * Progress deliberately lives *outside* the tabs: while a script runs it is the
 * only live feedback there is, and hiding it behind a tab would mean the user
 * has to guess whether anything is happening. Only the bulky output (log,
 * table, history) is tabbed.
 */
export function RunStatusBar({ running, structured, exitInfo }: RunStatusBarProps) {
  const { progress, status } = structured;
  const exited = exitInfo?.kind === "exit" ? exitInfo : null;

  // Nothing to say yet.
  if (!running && !progress && !status && !exited) return null;

  const failed = exited != null && exited.code !== 0;

  return (
    <div class="shrink-0 border-b border-line bg-surface px-5 py-2">
      <div class="flex items-baseline gap-3">
        {running && (
          <span
            class="mb-px h-1.5 w-1.5 shrink-0 self-center rounded-full bg-accent motion-safe:animate-pulse"
            aria-hidden="true"
          />
        )}
        <span class="min-w-0 flex-1 truncate text-[13px] text-muted">
          {progress?.message || status || (running ? "Running…" : "")}
        </span>
        {progress && (
          <span class="shrink-0 tabular-nums text-2xs text-subtle">
            {progress.pct.toFixed(0)}%
          </span>
        )}
        {exited && (
          <span
            class={`shrink-0 tabular-nums text-2xs ${failed ? "text-danger" : "text-ok"}`}
          >
            exit {exited.code ?? "—"} · {(exited.duration_ms / 1000).toFixed(1)}s · {exited.reason}
          </span>
        )}
      </div>

      {progress && (
        <div
          class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-fg/10"
          role="progressbar"
          aria-valuenow={Math.round(progress.pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={progress.message || "Progress"}
        >
          <div
            class="h-full rounded-full bg-accent transition-all duration-300"
            style={{ width: `${Math.max(0, Math.min(100, progress.pct))}%` }}
          />
        </div>
      )}
    </div>
  );
}
