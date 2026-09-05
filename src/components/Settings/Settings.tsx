import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ipc } from "../../lib/ipc";
import { useToast } from "../Toast";
import { ThemeToggle } from "../ThemeToggle";
import { TrashIcon } from "../icons";
import { ScriptIcon } from "../../lib/script-icon";
import { useI18n, LANGS } from "../../lib/i18n";
import type { AppSettings, DiskUsage, ScriptEntry, SecretEntry } from "../../types/schema";
import type { Theme } from "../../hooks/useTheme";
import type { AppUpdate } from "../../hooks/useAppUpdate";

interface SettingsProps {
  scripts: ScriptEntry[];
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  update: AppUpdate;
}

/** Retention bounds — mirror `store::settings` on the Rust side (which also
 * enforces them); shown here so the input can react before the round trip. */
const MIN_RETENTION = 1;
const MAX_RETENTION = 500;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** "Sep 5, 10:24" or "—" for secrets that predate the registry. */
function formatSetAt(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function Settings({ scripts, theme, onThemeChange, update }: SettingsProps) {
  const { t, lang, setLang } = useI18n();
  const { notify, notifyError } = useToast();
  const [usage, setUsage] = useState<DiskUsage | null>(null);
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [secrets, setSecrets] = useState<SecretEntry[] | null>(null);
  const [deletingSecret, setDeletingSecret] = useState<string | null>(null);

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await ipc<DiskUsage>("disk_usage"));
    } catch (e) {
      notifyError(e, "Could not read disk usage");
    }
  }, [notifyError]);

  const refreshSecrets = useCallback(async () => {
    try {
      setSecrets(await ipc<SecretEntry[]>("secrets_list"));
    } catch (e) {
      notifyError(e, "Could not list secrets");
    }
  }, [notifyError]);

  useEffect(() => {
    refreshUsage();
    refreshSecrets();
  }, [refreshUsage, refreshSecrets]);

  useEffect(() => {
    ipc<AppSettings>("get_settings")
      .then(setSettings)
      .catch((e) => notifyError(e, "Could not load settings"));
  }, [notifyError]);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  // Manual check: unlike the silent one at startup, this one has to answer —
  // a button that reports nothing looks broken.
  const handleCheckUpdate = useCallback(async () => {
    try {
      const found = await update.check(true);
      if (!found) notify("info", t("PyShell is up to date"));
    } catch (e) {
      notifyError(e, "Update check failed");
    }
  }, [update, notify, notifyError, t]);

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
      notify("info", t("Reclaimed {size}", { size: formatSize(Number(freed)) }));
    } catch (e) {
      notifyError(e, "Reclaim failed");
    } finally {
      setBusy(false);
    }
  }, [refreshUsage, notify, notifyError, t]);

  const handleResetEnv = useCallback(async (scriptId: string) => {
    setResettingId(scriptId);
    try {
      await ipc("reset_env", { scriptId });
      await refreshUsage();
      notify("info", t("Environment deleted — click Prepare Env to rebuild"));
    } catch (e) {
      notifyError(e, "Reset env failed");
    } finally {
      setResettingId(null);
    }
  }, [refreshUsage, notify, notifyError, t]);

  /** Persist the retention setting; the sanitized answer is what sticks. */
  const handleRetentionChange = useCallback(
    async (raw: string) => {
      const parsed = Math.round(Number(raw));
      if (!Number.isFinite(parsed)) return;
      const clamped = Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, parsed));
      setSettings((cur) => (cur ? { ...cur, retention_runs: clamped } : cur));
      try {
        // The backend clamps too — the returned value is authoritative.
        setSettings(await ipc<AppSettings>("set_settings", { settings: { retention_runs: clamped } }));
      } catch (e) {
        notifyError(e, "Could not save settings");
      }
    },
    [notifyError],
  );

  const handleDeleteSecret = useCallback(
    async (scriptId: string, key: string) => {
      setDeletingSecret(`${scriptId}:${key}`);
      try {
        await ipc("delete_secret", { scriptId, key });
        notify("info", t("Secret {key} deleted from the keychain", { key }));
      } catch (e) {
        notifyError(e, "Could not delete the secret");
      } finally {
        setDeletingSecret(null);
        refreshSecrets();
      }
    },
    [notify, notifyError, t, refreshSecrets],
  );

  // Bound once so TypeScript keeps the narrowing inside the JSX below.
  const release = update.release;

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
          <h1 class="mb-6 text-[17px] font-semibold tracking-tight">{t("Settings")}</h1>

          {/* Theme & language */}
          <section class="mb-8 rounded-xl border border-line bg-surface px-5 py-4">
            <div class="mb-1 text-[13px] font-medium">{t("Appearance")}</div>
            <p class="mb-3 text-2xs text-subtle">{t("Choose how PyShell looks. \"Match system\" follows your OS setting.")}</p>
            <ThemeToggle theme={theme} onChange={onThemeChange} />
            <div class="mt-4 flex items-center gap-2">
              <span class="panel-title flex-1">{t("Language")}</span>
              <select
                class="form-input w-auto py-1 text-xs"
                aria-label={t("Language")}
                value={lang}
                onChange={(e) => setLang(e.currentTarget.value as typeof lang)}
              >
                {LANGS.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
            <p class="mt-1.5 text-2xs text-subtle">{t("Interface language. The native menu bar stays in English for now.")}</p>
          </section>

          {/* Storage */}
          <section class="rounded-xl border border-line bg-surface px-5 py-4">
            <div class="mb-1 flex items-baseline gap-2">
              <span class="text-[13px] font-medium">{t("Storage")}</span>
              <span class="text-2xs text-subtle">{t("virtual environments, caches and run output")}</span>
            </div>
            <p class="mb-4 text-2xs text-subtle">
              {t("Envs are kept in Application Support, not next to your scripts. Reclaim removes orphans (scripts no longer imported) and stale environments left by changed requirements.")}
            </p>

            <div class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t("Total")} value={formatSize(total)} />
              <Stat label={t("Envs")} value={formatSize(envsBytes)} />
              <Stat label={t("uv cache")} value={formatSize(cache)} />
              <Stat label={t("Output")} value={formatSize(output)} />
            </div>

            {orphaned > 0 && (
              <div class="mb-4 flex items-center gap-3 rounded-lg border border-warn/30 bg-warn/[0.08] px-3 py-2">
                <span class="flex-1 text-2xs text-warn">
                  {t("{size} of orphaned environments can be reclaimed.", { size: formatSize(orphaned) })}
                </span>
                <button class="btn btn-warn py-1" onClick={handleReclaim} disabled={busy}>
                  {busy ? t("Reclaiming…") : t("Reclaim")}
                </button>
              </div>
            )}
            {orphaned === 0 && (
              <div class="mb-4">
                <button class="btn btn-secondary py-1" onClick={handleReclaim} disabled={busy}>
                  {busy ? t("Reclaiming…") : t("Reclaim orphans")}
                </button>
              </div>
            )}

            {/* Per-script table */}
            <div class="mb-1 text-2xs font-semibold uppercase tracking-wider text-subtle">
              {t("Per-script environments")}
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
                              <ScriptIcon icon={meta?.icon} size={12} class="mr-1.5" />
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
                                title={t("Delete this script's virtual environment")}
                              >
                                {resettingId === id ? "…" : (<><TrashIcon size={13} /> {t("Reset")}</>)}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p class="text-2xs text-subtle">{t("No environments on disk.")}</p>
            )}
          </section>

          {/* History & limits */}
          <section class="mt-8 rounded-xl border border-line bg-surface px-5 py-4">
            <div class="mb-1 flex items-baseline gap-2">
              <span class="text-[13px] font-medium">{t("History & limits")}</span>
              <span class="text-2xs text-subtle">{t("how much PyShell keeps, and for how long")}</span>
            </div>
            <div class="mt-3 flex items-center gap-3">
              <label class="flex-1 text-2xs text-subtle" for="retention-runs">
                {t("Runs kept per script")}
              </label>
              <input
                id="retention-runs"
                type="number"
                min={MIN_RETENTION}
                max={MAX_RETENTION}
                class="form-input w-24 py-1 text-right text-xs tabular-nums"
                value={settings?.retention_runs ?? ""}
                disabled={settings === null}
                onChange={(e) => handleRetentionChange(e.currentTarget.value)}
              />
            </div>
            <p class="mt-1.5 text-2xs leading-relaxed text-subtle">
              {t("Both the History list and the run folders on disk are trimmed to this many entries per script, so Log and Files always work for what History shows. Applies the next time a run finishes. {min}–{max}.", { min: MIN_RETENTION, max: MAX_RETENTION })}
            </p>

            {/* Fixed limits, shown read-only so they are at least visible
                (plan 2-4). Keep the numbers in step with the Rust constants:
                runner/stream.rs (cap), repo.rs (TTLs). */}
            <div class="mt-4 space-y-1 border-t border-line pt-3 text-2xs leading-relaxed text-subtle">
              <div>{t("Per-run output is capped at 50 MB / 500k lines — beyond that, the head and the tail are kept and the skipped middle is bannered. The full log is always on disk.")}</div>
              <div>{t("The Store catalog is re-checked from GitHub at most every 5 minutes.")}</div>
              <div>{t("The app-update check runs at most every 6 hours.")}</div>
            </div>
          </section>

          {/* Secrets */}
          <section class="mt-8 rounded-xl border border-line bg-surface px-5 py-4">
            <div class="mb-1 flex items-baseline gap-2">
              <span class="text-[13px] font-medium">{t("Secrets")}</span>
              <span class="text-2xs text-subtle">{t("stored in the OS keychain by PyShell")}</span>
            </div>
            <p class="mb-4 text-2xs text-subtle">
              {t("Every secret PyShell has stored, across all scripts. Values never leave the keychain — this list cannot show them, only remove them. Secrets are deleted along with their script.")}
            </p>

            {secrets === null ? (
              <p class="animate-pulse text-2xs text-subtle">{t("Loading…")}</p>
            ) : secrets.length === 0 ? (
              <p class="text-2xs text-subtle">{t("No secrets stored.")}</p>
            ) : (
              <div class="overflow-hidden rounded-lg border border-line">
                <table class="w-full border-collapse text-xs">
                  <tbody>
                    {secrets.map((s) => {
                      const meta = nameById.get(s.script_id);
                      const rowKey = `${s.script_id}:${s.key}`;
                      return (
                        <tr key={rowKey} class="row-hover">
                          <td class="border-b border-line/60 px-3 py-2">
                            <ScriptIcon icon={meta?.icon} size={12} class="mr-1.5" />
                            <span class="text-fg">{meta?.name ?? s.script_id}</span>
                          </td>
                          <td class="border-b border-line/60 px-3 py-2 font-mono text-muted">{s.key}</td>
                          <td class="border-b border-line/60 px-3 py-2 text-right tabular-nums text-subtle">
                            <span title={s.set_at ?? undefined}>{formatSetAt(s.set_at)}</span>
                          </td>
                          <td class="border-b border-line/60 px-3 py-2 text-right">
                            <button
                              class="btn btn-ghost py-1 text-danger hover:bg-danger/10"
                              onClick={() => handleDeleteSecret(s.script_id, s.key)}
                              disabled={deletingSecret === rowKey}
                              title={t("Delete this secret from the keychain")}
                            >
                              {deletingSecret === rowKey ? "…" : (<><TrashIcon size={13} /> {t("Delete")}</>)}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* About & updates */}
          <section class="mt-8 rounded-xl border border-line bg-surface px-5 py-4">
            <div class="mb-1 flex items-baseline gap-2">
              <span class="text-[13px] font-medium">{t("About")}</span>
              {version && <span class="text-2xs tabular-nums text-subtle">{t("version {version}", { version })}</span>}
            </div>
            <p class="mb-4 text-2xs text-subtle">
              {t("PyShell checks GitHub for a newer release and says so when one appears. It does not install updates itself — Download opens the release page, where you get the .dmg.")}
            </p>

            {release ? (
              <div class="flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/[0.08] px-3 py-2">
                <span class="flex-1 text-2xs text-accent">
                  {t("PyShell {version} is available", { version: release.version })}
                </span>
                <button
                  class="btn btn-primary py-1"
                  onClick={() =>
                    openUrl(release.url).catch((e) => notifyError(e, "Could not open the release page"))
                  }
                >
                  {t("Download")}
                </button>
              </div>
            ) : (
              <button
                class="btn btn-secondary py-1"
                onClick={handleCheckUpdate}
                disabled={update.checking}
              >
                {update.checking ? t("Checking…") : t("Check for updates")}
              </button>
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
