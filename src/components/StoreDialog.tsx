import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import type { RepoInstallResult, RepoScript, ScriptEntry } from "../types/schema";
import { ScriptIcon } from "../lib/script-icon";
import { filterCatalog, formatBytes, groupCatalog, hasUpdate, installStateOf } from "../lib/store-utils";
import { useToast } from "./Toast";
import { Modal } from "./Modal";
import { useI18n } from "../lib/i18n";
import {
  AlertIcon,
  CheckIcon,
  CloseIcon,
  DownloadIcon,
  FolderIcon,
  RefreshIcon,
  SearchIcon,
  StoreIcon,
  TrashIcon,
  WrenchIcon,
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
 * omits the field over IPC when the list is empty (serde skip), so every
 * catalog read fills it in on receipt and the rows can index it freely. */
type StoreEntry = RepoScript & { needs: string[] };

const normalize = (list: RepoScript[]): StoreEntry[] =>
  list.map((e) => ({ ...e, needs: e.needs ?? [] }));

/** The row action awaiting confirmation: which verb, on which entry. */
interface ConfirmAction {
  kind: "update" | "repair" | "uninstall";
  entry: StoreEntry;
}

interface StoreDialogProps {
  /** Current imports, for the "Installed" badge and update detection (match by manifest id). */
  scripts: ScriptEntry[];
  /** Ids of scripts with a running job — updating one is blocked while it runs. */
  runningScripts: string[];
  /** Called with the freshly imported entry — the caller refreshes and selects it. */
  onInstalled: (entry: ScriptEntry) => void;
  /** Called after an Uninstall removed the script — the caller drops its UI state. */
  onRemoved: (scriptId: string) => void;
  onClose: () => void;
}

/**
 * The Script Store: installable scripts from the community repo.
 *
 * Catalog and downloads happen in Rust (`repo.rs`); this component only talks
 * IPC. Escape and focus handling come from the shared [`Modal`]; the action
 * confirms register their own on top, so Escape peels them off first.
 *
 * Row actions: Install (not imported), Update (repo carries a different
 * version), Repair (re-download over the existing folder — the same swap as
 * Update, without the version gate, for installs whose files went bad) and
 * Uninstall (the sidebar's Remove, without leaving the dialog).
 */
export function StoreDialog({ scripts, runningScripts, onInstalled, onRemoved, onClose }: StoreDialogProps) {
  const { t } = useI18n();
  const { notify, notifyError } = useToast();
  const [entries, setEntries] = useState<StoreEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [dest, setDest] = useState<string>(loadDest);
  const [installing, setInstalling] = useState<InstallState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);

  const loadCatalog = useCallback(
    async (force: boolean) => {
      if (force) setRefreshing(true);
      setError(null);
      if (!force) setEntries(null);
      try {
        const list = await ipc<RepoScript[]>("repo_catalog", { forceRefresh: force });
        setEntries(normalize(list));
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

  /**
   * Re-read the catalog after an install, update, repair or uninstall,
   * keeping the list on screen.
   *
   * `installed_version` is enriched **per call** on the Rust side, so rows
   * fetched before the change carry a stale one — and the row the user just
   * acted on is exactly the row that goes wrong. A fresh install kept
   * `installed_version` absent, which `hasUpdate` reads as "the repo has a
   * version the install does not" and offered an Update for the very files it
   * had just downloaded; an updated row kept its old version and its Update
   * button, where a second click would swap the folder again and leave another
   * `.backup-*` behind.
   *
   * Costs no network: the Rust catalog cache is still fresh (`CATALOG_TTL`),
   * so this only re-runs the enrichment. Failure is swallowed — the action
   * itself succeeded, and an error banner over a dialog that did its job would
   * be the bigger lie; the rows simply stay as they were until Refresh.
   */
  const reenrich = useCallback(async () => {
    try {
      setEntries(normalize(await ipc<RepoScript[]>("repo_catalog", { forceRefresh: false })));
    } catch {
      /* keep the rows as they are */
    }
  }, []);

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
        title: t("Download scripts into this folder"),
      });
      if (selected && typeof selected === "string") {
        setDest(selected);
        try {
          localStorage.setItem(DEST_KEY, selected);
        } catch { /* ignore */ }
      }
    } catch (e) {
      notifyError(e, t("Choosing the destination failed"));
    }
  }, [notifyError, t]);

  const install = useCallback(
    async (dir: string) => {
      if (!dest || installing) return;
      setInstalling({ root: dir, dir, done: 0, total: 0 });
      try {
        const result = await ipc<RepoInstallResult>("repo_install", { dir, destination: dest });
        // The backend pulled in missing `needs` alongside; one toast for all.
        const extra = result.extras.length > 0
          ? ` (+${t("{n} dependencies installed", { n: result.extras.length })})`
          : "";
        notify("info", `${t("Installed {name}", { name: result.entry.name })}${extra}`);
        onInstalled(result.entry);
        // The chain may have installed dependencies too, so re-read the whole
        // catalog rather than patching the one row.
        await reenrich();
      } catch (e) {
        notifyError(e, t("Install failed"));
      } finally {
        setInstalling(null);
      }
    },
    [dest, installing, notify, notifyError, onInstalled, reenrich, t],
  );

  // Update and Repair walk the same backend path (`repo_update`: staging →
  // two renames → backup). The only difference is the gate: Update shows when
  // the repo carries a different version, Repair is always offered on an
  // installed row — for files that went bad without the author shipping a new
  // version.
  const swapFolder = useCallback(
    async (dir: string, verb: "update" | "repair") => {
      if (installing) return;
      setInstalling({ root: dir, dir, done: 0, total: 0 });
      try {
        const entry = await ipc<ScriptEntry>("repo_update", { dir });
        notify(
          "info",
          verb === "update"
            ? t("Updated {name} — the previous folder is kept as a .backup beside it", { name: entry.name })
            : t("Repaired {name} — the previous folder is kept as a .backup beside it", { name: entry.name }),
        );
        onInstalled(entry);
        await reenrich();
      } catch (e) {
        notifyError(e, verb === "update" ? t("Update failed") : t("Repair failed"));
      } finally {
        setInstalling(null);
        setConfirm(null);
      }
    },
    [installing, notify, notifyError, onInstalled, reenrich, t],
  );

  // Uninstall is the sidebar's Remove, without leaving the dialog: same
  // backend command, same cleanup (env, schema, bookmarks, state, output,
  // favorites, keychain secrets).
  const uninstall = useCallback(
    async (scriptId: string, name: string) => {
      try {
        await ipc("remove_script", { scriptId, deleteEnv: true });
        notify("info", t("Uninstalled {name}", { name }));
        onRemoved(scriptId);
        await reenrich();
      } catch (e) {
        notifyError(e, t("Uninstall failed"));
      } finally {
        setConfirm(null);
      }
    },
    [notify, notifyError, onRemoved, reenrich, t],
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

  const confirmTitle = confirm
    ? confirm.kind === "update"
      ? t("Update {name}?", { name: confirm.entry.name })
      : confirm.kind === "repair"
        ? t("Repair {name}?", { name: confirm.entry.name })
        : t("Uninstall {name}?", { name: confirm.entry.name })
    : "";

  return (
    <Modal
      onClose={onClose}
      title={t("Script Store")}
      overlayClass="z-[60]"
      panelClass="mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col"
      padded={false}
    >
      <div class="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 class="flex items-center gap-2 text-[15px] font-semibold">
          <StoreIcon size={17} class="text-accent" />
          {t("Script Store")}
          {entries && (
            <span class="text-2xs font-normal text-subtle">
              {t("{n} scripts", { n: entries.length })} ·{" "}
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
            title={t("Re-fetch the catalog from GitHub (spends one API request)")}
            aria-label={t("Refresh catalog")}
          >
            <RefreshIcon size={13} class={refreshing ? "motion-safe:animate-spin" : ""} />
          </button>
          <button type="button" class="btn btn-ghost" onClick={onClose} aria-label={t("Close")}>
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
            {dest || t("Choose a destination folder…")}
          </span>
        </button>
        <button type="button" class="btn btn-secondary shrink-0" onClick={chooseDest}>
          {t("Choose…")}
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
            placeholder={t("Search the store…")}
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          {query && (
            <button
              type="button"
              class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-fg"
              onClick={() => setQuery("")}
              title={t("Clear search")}
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
              <RefreshIcon size={13} /> {t("Retry")}
            </button>
          </div>
        )}

        {!error && entries === null && (
          <p class="animate-pulse px-1 py-6 text-center text-2xs text-subtle">
            {t("Loading the catalog from GitHub…")}
          </p>
        )}

        {!error && entries !== null && visible.length === 0 && (
          <p class="px-1 py-6 text-center text-2xs text-subtle">
            {entries.length === 0
              ? t("No scripts found in the repo.")
              : t("Nothing matches \"{q}\".", { q: query })}
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
                        <span class="shrink-0 text-2xs text-subtle" title={t("Script version")}>
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
                      {t("{n} files", { n: e.files })} · {formatBytes(e.size_bytes)}
                      {e.needs.length > 0 && (
                        <span title={t("Installed automatically alongside this script")}>
                          {" · "}{t("needs")} {e.needs.map((id) => namesById.get(id) ?? id).join(", ")}
                        </span>
                      )}
                      {updateAvailable && (
                        <span class="text-warn">
                          {" · "}{t("update available")}
                          {e.installed_version && e.version
                            ? `: v${e.installed_version} → v${e.version}`
                            : ""}
                        </span>
                      )}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-1.5 self-center">
                    {isInstalling ? (
                      <span class="text-2xs tabular-nums text-subtle">
                        {installing.total > 0
                          ? installing.dir !== installing.root
                            ? `${installing.dir}: ${installing.done}/${installing.total}…`
                            : t("Downloading {done}/{total}…", { done: installing.done, total: installing.total })
                          : t("Starting…")}
                      </span>
                    ) : state === "unreachable" ? (
                      /* The id is imported but the folder is gone: not a
                         healthy install, and Update has nothing to swap —
                         point at the sidebar's relink flow instead. */
                      <span
                        class="pill bg-warn/12 text-warn"
                        title={t("Imported, but the script's folder is gone. Relink it with Find on its row in the sidebar — that keeps presets and history; removing and reinstalling would not.")}
                      >
                        <AlertIcon size={11} /> {t("Missing folder")}
                      </span>
                    ) : state === "installable" ? (
                      <button
                        type="button"
                        class="btn btn-primary"
                        onClick={() => install(e.dir)}
                        disabled={!dest || installing !== null}
                        title={
                          dest
                            ? t("Download into {path} and import", { path: `${dest}/${e.dir}` })
                            : t("Choose a destination folder first")
                        }
                      >
                        <DownloadIcon size={13} /> {t("Install")}
                      </button>
                    ) : updateAvailable ? (
                      <button
                        type="button"
                        class="btn btn-secondary"
                        onClick={() => setConfirm({ kind: "update", entry: e })}
                        disabled={installing !== null || isRunning}
                        title={
                          isRunning
                            ? t("A job of this script is running — stop it before updating")
                            : t("Replace the installed folder with v{version} from the repo", { version: e.version ?? "?" })
                        }
                      >
                        <RefreshIcon size={13} /> {t("Update")}
                      </button>
                    ) : (
                      <>
                        <span
                          class="pill bg-ok/12 text-ok"
                          title={t("Already imported — its id is in your script list")}
                        >
                          <CheckIcon size={11} /> {t("Installed")}
                        </span>
                        <button
                          type="button"
                          class="btn btn-ghost px-1.5"
                          onClick={() => setConfirm({ kind: "repair", entry: e })}
                          disabled={installing !== null || isRunning}
                          title={t("Re-download the folder from the repo, replacing the current files (kept as a .backup)")}
                          aria-label={t("Repair")}
                        >
                          <WrenchIcon size={13} />
                        </button>
                        <button
                          type="button"
                          class="btn btn-ghost px-1.5 hover:text-danger"
                          onClick={() => setConfirm({ kind: "uninstall", entry: e })}
                          disabled={installing !== null}
                          title={t("Remove the script, its environment, presets, history and secrets")}
                          aria-label={t("Uninstall")}
                        >
                          <TrashIcon size={13} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div class="border-t border-line px-5 py-2.5 text-2xs leading-relaxed text-subtle">
        {t("Scripts are downloaded from the community repo and imported like a local folder. They run with your permissions — review the code before running it.")}
      </div>

      {/* Action confirm — sits above the dialog on the Escape stack, so the
          destructive action is never one click away. */}
      {confirm && (
        <Modal
          onClose={() => setConfirm(null)}
          title={confirmTitle}
          overlayClass="z-[70]"
          panelClass="max-w-sm"
          dismissable={confirm.kind !== "uninstall"}
        >
          <h2 class="mb-1.5 text-[15px] font-semibold">{confirmTitle}</h2>
          {confirm.kind === "uninstall" ? (
            <p class="mb-4 text-[13px] leading-relaxed text-muted">
              {t("The script is removed from the list along with its virtual environment, presets, run history and stored secrets. The folder itself stays on disk — delete it by hand if you want it gone.")}
            </p>
          ) : (
            <p class="mb-4 text-[13px] leading-relaxed text-muted">
              {confirm.kind === "update"
                ? t("The script's folder will be replaced with the repo's current version{version}. Your presets, history and secrets are kept; the environment rebuilds if its dependencies changed. The current folder — including any local edits — is kept as a .backup beside the new one.", { version: confirm.entry.version ? ` (v${confirm.entry.version})` : "" })
                : t("The folder's files are re-downloaded from the repo, replacing whatever is there now — useful when files were corrupted or edited by mistake. Presets, history and secrets are kept; the current folder is kept as a .backup beside the new one.")}
            </p>
          )}
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn btn-secondary"
              autoFocus
              onClick={() => setConfirm(null)}
            >
              {t("Cancel")}
            </button>
            <button
              type="button"
              class={`btn ${confirm.kind === "uninstall" ? "btn-danger" : "btn-primary"}`}
              onClick={() => {
                if (confirm.kind === "uninstall") uninstall(confirm.entry.id, confirm.entry.name);
                else swapFolder(confirm.entry.dir, confirm.kind);
              }}
            >
              {confirm.kind === "update" ? t("Update") : confirm.kind === "repair" ? t("Repair") : t("Uninstall")}
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
