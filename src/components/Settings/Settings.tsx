import { useState, useCallback, useEffect, useMemo } from "preact/hooks";
import { ipc } from "../../lib/ipc";
import { useToast } from "../Toast";
import { ThemeToggle } from "../ThemeToggle";
import { TrashIcon } from "../icons";
import type { DiskUsage, ScriptEntry } from "../../types/schema";
import type { Theme } from "../../hooks/useTheme";

interface SettingsProps {
  scripts: ScriptEntry[];
  theme: Theme;
  onThemeChange: (t: Theme) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function Settings({ scripts, theme, onThemeChange }: SettingsProps) {
  const [usage, setUsage] = useState<DiskUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const { notify, notifyError } = useToast();

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await ipc<DiskUsage>("disk_usage"));
    } catch (e) {
      notifyError(e, "Could not read disk usage");
    }
  }, [notifyError]);

  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

  const nameById = useMemo(() => {
    const m = new Map<string, { name: string; icon: string | null }>();
    for (const s of scripts) m.set(s.id, { name: s.name, icon: s.icon });
    return m;
  }, [scripts]);

  const handleReclaim = useCallback(async () => {
    setBusy(true);
    try {
      const freed = await ipc<number>("gc_envs");
      await refreshUsage();
      notify("info", `Reclaimed ${formatSize(Number(freed))}`);
    } catch (e) {
      notifyError(e, "Reclaim failed");
    } finally {
      setBusy(false);
    }
  }, [refreshUsage, notify, notifyError]);

  const handleResetEnv = useCallback(async (scriptId: string) => {
    setResettingId(scriptId);
    try {
      await ipc("reset_env", { scriptId });
      await refreshUsage();
      notify("info", "Environment deleted — click Prepare Env to rebuild");
    } catch (e) {
      notifyError(e, "Reset env failed");
    } finally {
      setResettingId(null);
    }
  }, [refreshUsage, notify, notifyError]);

  const total = usage ? Number(usage.total_bytes) : 0;
  const cache = usage ? Number(usage.uv_cache_bytes) : 0;
  const output = usage ? Number(usage.output_bytes) : 0;
  const orphaned = usage ? Number(usage.orphaned_bytes) : 0;
  const envsBytes = Math.max(0, total - cache - output);

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      {/* The window is frameless, so every full-height pane owes the top edge a
          drag strip — without one, Settings is a place where the window cannot
          be moved. Its height also clears the traffic lights. */}
      <div data-tauri-drag-region class="h-8 shrink-0" />
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-3xl px-6 pb-10">
          <h1 class="mb-6 text-[17px] font-semibold tracking-tight">Settings</h1>

          {/* Theme */}
          <section class="mb-8 rounded-xl border border-line bg-surface px-5 py-4">
            <div class="mb-1 text-[13px] font-medium">Appearance</div>
            <p class="mb-3 text-2xs text-subtle">Choose how PyShell looks. "Match system" follows your OS setting.</p>
            <ThemeToggle theme={theme} onChange={onThemeChange} />
          </section>

          {/* Storage */}
          <section class="rounded-xl border border-line bg-surface px-5 py-4">
            <div class="mb-1 flex items-baseline gap-2">
              <span class="text-[13px] font-medium">Storage</span>
              <span class="text-2xs text-subtle">virtual environments, caches and run output</span>
            </div>
            <p class="mb-4 text-2xs text-subtle">
              Envs are kept in Application Support, not next to your scripts. Reclaim removes orphans
              (scripts no longer imported) and stale environments left by changed requirements.
            </p>

            <div class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Total" value={formatSize(total)} />
              <Stat label="Envs" value={formatSize(envsBytes)} />
              <Stat label="uv cache" value={formatSize(cache)} />
              <Stat label="Output" value={formatSize(output)} />
            </div>

            {orphaned > 0 && (
              <div class="mb-4 flex items-center gap-3 rounded-lg border border-warn/30 bg-warn/[0.08] px-3 py-2">
                <span class="flex-1 text-2xs text-warn">
                  {formatSize(orphaned)} of orphaned environments can be reclaimed.
                </span>
                <button class="btn btn-warn py-1" onClick={handleReclaim} disabled={busy}>
                  {busy ? "Reclaiming…" : "Reclaim"}
                </button>
              </div>
            )}
            {orphaned === 0 && (
              <div class="mb-4">
                <button class="btn btn-secondary py-1" onClick={handleReclaim} disabled={busy}>
                  {busy ? "Reclaiming…" : "Reclaim orphans"}
                </button>
              </div>
            )}

            {/* Per-script table */}
            <div class="mb-1 text-2xs font-semibold uppercase tracking-wider text-subtle">
              Per-script environments
            </div>
            {usage && usage.per_script.length > 0 ? (
              <div class="overflow-hidden rounded-lg border border-line">
                <table class="w-full border-collapse text-xs">
                  <tbody>
                    {usage.per_script
                      .slice()
                      .sort((a, b) => Number(b[1]) - Number(a[1]))
                      .map(([id, size]) => {
                        const meta = nameById.get(id);
                        return (
                          <tr key={id} class="row-hover">
                            <td class="border-b border-line/60 px-3 py-2">
                              <span class="mr-1.5">{meta?.icon ?? "📄"}</span>
                              <span class="text-fg">{meta?.name ?? id}</span>
                            </td>
                            <td class="border-b border-line/60 px-3 py-2 text-right tabular-nums text-muted">
                              {formatSize(Number(size))}
                            </td>
                            <td class="border-b border-line/60 px-3 py-2 text-right">
                              <button
                                class="btn btn-ghost py-1 text-danger hover:bg-danger/10"
                                onClick={() => handleResetEnv(id)}
                                disabled={resettingId === id}
                                title="Delete this script's virtual environment"
                              >
                                {resettingId === id ? "…" : (<><TrashIcon size={13} /> Reset</>)}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p class="text-2xs text-subtle">No environments on disk.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div class="rounded-lg border border-line bg-raised px-3 py-2">
      <div class="text-2xs text-subtle">{label}</div>
      <div class="text-[15px] font-semibold tabular-nums text-fg">{value}</div>
    </div>
  );
}
