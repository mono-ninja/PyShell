import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import type { RepoInstallResult, RepoScript, ScriptEntry } from "../types/schema";
import { ScriptIcon } from "../lib/script-icon";
import { filterCatalog, formatBytes, groupCatalog, hasUpdate, installStateOf } from "../lib/store-utils";
import { useToast } from "./Toast";
import { useEscape } from "../lib/keyboard";
import {
  AlertIcon,
  CheckIcon,
  CloseIcon,
  DownloadIcon,
  FolderIcon,
  RefreshIcon,
  SearchIcon,
  StoreIcon,
} from "./icons";
import { ExternalLink } from "../lib/markdown";
import { SCRIPTS_URL } from "../lib/links";

const DEST_KEY = "pyshell:store-dest";

function loadDest(): string {
  try {
    return localStorage.getItem(DEST_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Payload of the `repo:install-progress` event — one per downloaded file. */
interface InstallProgress {
  dir: string;
  done: number;
  total: number;
}

/** What the dialog tracks for one in-flight install. `root` is the folder the
 * user clicked; `dir` moves through the dependency chain the backend pulls in
 * alongside, so the progress line can say which folder is downloading. */
interface InstallState extends InstallProgress {
  root: string;
}

/** A `RepoScript` with `needs` normalized to always-present: the backend
 * omits the field over IPC when the list is empty (serde skip), so
 * `loadCatalog` fills it in on receipt and the rows can index it freely. */
type StoreEntry = RepoScript & { needs: string[] };

interface StoreDialogProps {
  /** Current imports, for the "Installed" badge and update detection (match by manifest id). */
  scripts: ScriptEntry[];
  /** Ids of scripts with a running job — updating one is blocked while it runs. */
  runningScripts: string[];
  /** Called with the freshly imported entry — the caller refreshes and selects it. */
  onInstalled: (entry: ScriptEntry) => void;
  onClose: () => void;
}

/**
 * The Script Store: installable scripts from the community repo.
 *
 * Catalog and downloads happen in Rust (`repo.rs`); this component only talks
 * IPC. Escape is registered by the caller through `useEscape`, like the other
 * full-screen overlays; the update confirm registers its own on top, so
 * Escape peels it off first.
 */
export function StoreDialog({ scripts, runningScripts, onInstalled, onClose }: StoreDialogProps) {
  const { notify, notifyError } = useToast();
  const [entries, setEntries] = useState<StoreEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [dest, setDest] = useState<string>(loadDest);
  const [installing, setInstalling] = useState<InstallState | null>(null);
  const [confirmUpdate, setConfirmUpdate] = useState<RepoScript | null>(null);

  useEscape(confirmUpdate !== null, () => setConfirmUpdate(null));

  const loadCatalog = useCallback(
    async (force: boolean) => {
      if (force) setRefreshing(true);
      setError(null);
      if (!force) setEntries(null);
      try {
        const list = await ipc<RepoScript[]>("repo_catalog", { forceRefresh: force });
        // The backend omits `needs` when empty (serde skip), so normalize on
        // receipt — the rows below can then treat it as always-present.
        const normalized: StoreEntry[] = list.map((e) => ({ ...e, needs: e.needs ?? [] }));
        setEntries(normalized);
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    loadCatalog(false);
  }, [loadCatalog]);

  // Per-file progress of the running install. The Rust side emits one event
  // per completed file, so this is low-frequency by construction. A batch
  // install (dependencies pulled in alongside) emits for each folder — the
  // root the user clicked stays put while `dir` follows the chain.
  useEffect(() => {
    const unlisten = listen<InstallProgress>("repo:install-progress", (event) => {
      setInstalling((cur) => (cur ? { root: cur.root, ...event.payload } : null));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const chooseDest = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Download scripts into this folder",
      });
      if (selected && typeof selected === "string") {
        setDest(selected);
        try {
          localStorage.setItem(DEST_KEY, selected);
        } catch { /* ignore */ }
      }
    } catch (e) {
      notifyError(e, "Choosing the destination failed");
    }
  }, [notifyError]);

  const install = useCallback(
    async (dir: string) => {
      if (!dest || installing) return;
      setInstalling({ root: dir, dir, done: 0, total: 0 });
      try {
        const result = await ipc<RepoInstallResult>("repo_install", { dir, destination: dest });
        // The backend pulled in missing `needs` alongside; one toast for all.
        const extra = result.extras.length > 0
          ? ` (+${result.extras.length} dependenc${result.extras.length === 1 ? "y" : "ies"})`
          : "";
        notify("info", `Installed ${result.entry.name}${extra}`);
        onInstalled(result.entry);
      } catch (e) {
        notifyError(e, "Install failed");
      } finally {
        setInstalling(null);
      }
    },
    [dest, installing, notify, notifyError, onInstalled],
  );

  // The destination was resolved on the Rust side (the installed script's own
  // folder), so only `dir` crosses the IPC boundary.
  const update = useCallback(
    async (dir: string) => {
      if (installing) return;
      setInstalling({ root: dir, dir, done: 0, total: 0 });
      try {
        const entry = await ipc<ScriptEntry>("repo_update", { dir });
        notify("info", `Updated ${entry.name} — the previous folder is kept as a .backup beside it`);
        onInstalled(entry);
      } catch (e) {
        notifyError(e, "Update failed");
      } finally {
        setInstalling(null);
        setConfirmUpdate(null);
      }
    },
    [installing, notify, notifyError, onInstalled],
  );

  // Display names for the `needs` ids in a row — a need that is not a store
  // script (a local-only helper id) falls back to the raw id.
  const namesById = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries ?? []) m.set(e.id, e.name);
    return m;
  }, [entries]);
  const visible = filterCatalog(entries ?? [], query);
  const sections = useMemo(() => groupCatalog(visible), [visible]);

  return (
    <div
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        class="mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-line bg-raised shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 class="flex items-center gap-2 text-[15px] font-semibold">
            <StoreIcon size={17} class="text-accent" />
            Script Store
            {entries && (
              <span class="text-2xs font-normal text-subtle">
                {entries.length} script{entries.length === 1 ? "" : "s"} ·{" "}
                <ExternalLink href={SCRIPTS_URL}>PyShell-scripts</ExternalLink>
              </span>
            )}
          </h2>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="btn btn-secondary px-2"
              onClick={() => loadCatalog(true)}
              disabled={refreshing || installing !== null}
              title="Re-fetch the catalog from GitHub (spends one API request)"
              aria-label="Refresh catalog"
            >
              <RefreshIcon size={13} class={refreshing ? "motion-safe:animate-spin" : ""} />
            </button>
            <button type="button" class="btn btn-ghost" onClick={onClose} aria-label="Close">
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Destination: remembered across sessions, re-asked with one click.
            Install is disabled until one is chosen — downloading into a
            surprise location is worse than one extra click. */}
        <div class="flex items-center gap-2 border-b border-line px-5 py-3">
          <button type="button" class="form-picker flex-1" onClick={chooseDest}>
            <FolderIcon size={15} class="shrink-0 text-subtle" />
            <span class={`truncate text-[13px] ${dest ? "" : "text-subtle"}`}>
              {dest || "Choose a destination folder…"}
            </span>
          </button>
          <button type="button" class="btn btn-secondary shrink-0" onClick={chooseDest}>
            Choose…
          </button>
        </div>

        <div class="border-b border-line px-5 py-2.5">
          <div class="relative">
            <SearchIcon
              size={13}
              class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle"
            />
            <input
              type="text"
              class="form-input w-full py-1 pl-7 pr-7 text-[13px]"
              placeholder="Search the store…"
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            {query && (
              <button
                type="button"
                class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-fg"
                onClick={() => setQuery("")}
                title="Clear search"
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
        </div>

        <div class="flex-1 space-y-1.5 overflow-y-auto px-4 py-3">
          {error && (
            <div class="rounded-lg border border-line bg-surface px-4 py-6 text-center">
              <p class="mx-auto max-w-md text-[13px] leading-relaxed text-muted">{error}</p>
              <button
                type="button"
                class="btn btn-secondary mt-3"
                onClick={() => loadCatalog(true)}
              >
                <RefreshIcon size={13} /> Retry
              </button>
            </div>
          )}

          {!error && entries === null && (
            <p class="animate-pulse px-1 py-6 text-center text-2xs text-subtle">
              Loading the catalog from GitHub…
            </p>
          )}

          {!error && entries !== null && visible.length === 0 && (
            <p class="px-1 py-6 text-center text-2xs text-subtle">
              {entries.length === 0
                ? "No scripts found in the repo."
                : `Nothing matches "${query}".`}
            </p>
          )}

          {sections.map((section) => (
            <div key={section.key} class="mb-1">
              {/* Same section header idiom as the sidebar, so the store and
                  the script list read as one app. */}
              <div class="px-1.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-subtle">
                {section.label}
                <span class="ml-1 text-subtle/60">{section.items.length}</span>
              </div>
              {section.items.map((e) => {
                const state = installStateOf(e, scripts);
                const updateAvailable = state === "installed" && hasUpdate(e);
                const isInstalling = installing?.root === e.dir;
                const isRunning = runningScripts.includes(e.id);
                return (
                  <div
                    key={e.dir}
                    class="mb-1.5 flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5"
                  >
                    <ScriptIcon icon={e.icon} size={22} class="mt-0.5 shrink-0" />
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="truncate text-[13px] font-medium">{e.name}</span>
                        {e.version && (
                          <span class="shrink-0 text-2xs text-subtle" title="Script version">
                            v{e.version}
                          </span>
                        )}
                      </div>
                      {e.description && (
                        <p class="mt-0.5 line-clamp-2 text-2xs leading-snug text-muted">
                          {e.description}
                        </p>
                      )}
                      <p class="mt-1 text-2xs text-subtle">
                        {e.files} file{e.files === 1 ? "" : "s"} · {formatBytes(e.size_bytes)}
                        {e.needs.length > 0 && (
                          <span title="Installed automatically alongside this script">
                            {" · "}needs {e.needs.map((id) => namesById.get(id) ?? id).join(", ")}
                          </span>
                        )}
                        {updateAvailable && (
                          <span class="text-warn">
                            {" · "}update available
                            {e.installed_version && e.version
                              ? `: v${e.installed_version} → v${e.version}`
                              : ""}
                          </span>
                        )}
                      </p>
                    </div>
                    <div class="shrink-0 self-center">
                      {isInstalling ? (
                        <span class="text-2xs tabular-nums text-subtle">
                          {installing.total > 0
                            ? installing.dir !== installing.root
                              ? `${installing.dir}: ${installing.done}/${installing.total}…`
                              : `Downloading ${installing.done}/${installing.total}…`
                            : "Starting…"}
                        </span>
                      ) : state === "unreachable" ? (
                        /* The id is imported but the folder is gone: not a
                           healthy install, and Update has nothing to swap —
                           point at the sidebar's relink flow instead. */
                        <span
                          class="pill bg-warn/12 text-warn"
                          title="Imported, but the script's folder is gone. Relink it with Find on its row in the sidebar — that keeps presets and history; removing and reinstalling would not."
                        >
                          <AlertIcon size={11} /> Missing folder
                        </span>
                      ) : state === "installable" ? (
                        <button
                          type="button"
                          class="btn btn-primary"
                          onClick={() => install(e.dir)}
                          disabled={!dest || installing !== null}
                          title={
                            dest
                              ? `Download into ${dest}/${e.dir} and import`
                              : "Choose a destination folder first"
                          }
                        >
                          <DownloadIcon size={13} /> Install
                        </button>
                      ) : updateAvailable ? (
                    <button
                      type="button"
                      class="btn btn-secondary"
                      onClick={() => setConfirmUpdate(e)}
                      disabled={installing !== null || isRunning}
                      title={
                        isRunning
                          ? "A job of this script is running — stop it before updating"
                          : `Replace the installed folder with v${e.version ?? "?"} from the repo`
                      }
                    >
                      <RefreshIcon size={13} /> Update
                    </button>
                  ) : (
                    <span
                      class="pill bg-ok/12 text-ok"
                      title="Already imported — its id is in your script list"
                    >
                      <CheckIcon size={11} /> Installed
                    </span>
                  )}
                </div>
              </div>
                );
              })}
            </div>
          ))}
        </div>

        <div class="border-t border-line px-5 py-2.5 text-2xs leading-relaxed text-subtle">
          Scripts are downloaded from the community repo and imported like a local folder. They
          run with your permissions — review the code before running it.
        </div>
      </div>

      {/* Update confirm — sits above the dialog on the Escape stack, so the
          destructive action is never one click away. */}
      {confirmUpdate && (
        <div
          class="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setConfirmUpdate(null)}
        >
          <div
            class="max-w-sm rounded-xl border border-line bg-raised p-5 shadow-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="mb-1.5 text-[15px] font-semibold">
              Update {confirmUpdate.name}?
            </h2>
            <p class="mb-4 text-[13px] leading-relaxed text-muted">
              The script's folder will be replaced with the repo's current version
              {confirmUpdate.version ? ` (v${confirmUpdate.version})` : ""}. Your presets,
              history and secrets are kept; the environment rebuilds if its dependencies
              changed. The current folder — including any local edits — is kept as a{" "}
              <span class="font-mono">.backup</span> beside the new one.
            </p>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="btn btn-secondary"
                autoFocus
                onClick={() => setConfirmUpdate(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-primary"
                onClick={() => update(confirmUpdate.dir)}
              >
                Update
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
