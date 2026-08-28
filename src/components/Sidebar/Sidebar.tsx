import { useState, useRef, useEffect, useMemo, useCallback } from "preact/hooks";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "../../lib/ipc";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ScriptEntry } from "../../types/schema";
import { ChevronIcon, ClockIcon, CloseIcon, EditorIcon, FolderIcon, GearIcon, RefreshIcon, SearchIcon, SortIcon, StarIcon, TerminalIcon } from "../icons";
import { ScriptIcon } from "../../lib/script-icon";
import { ContextMenu } from "../ContextMenu";
import type { MenuItem } from "../ContextMenu";
import { useToast } from "../Toast";
import { useMenuAction } from "../../hooks/useMenuAction";
import { useEscape, hasOverlay, isTypingTarget } from "../../lib/keyboard";
import { ExternalLink } from "../../lib/markdown";
import { SCRIPTS_URL } from "../../lib/links";

/** Section keys that are not category names. A U+0000 prefix cannot collide
 *  with a category coming from a manifest. */
const UNGROUPED = "\u0000ungrouped";
export const FAVORITES = "\u0000favorites";
const OTHER_LABEL = "Other";

/** Case- and accent-insensitive, so "arachni" and "Arachni" sort together. */
const byLabel = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });
const byName = (a: ScriptEntry, b: ScriptEntry) => byLabel(a.name, b.name);

export interface Section {
  /** Stable key for collapse state; `UNGROUPED` for the uncategorised bucket. */
  key: string;
  label: string;
  items: ScriptEntry[];
  /** False only for the uncategorised tail in insertion order. */
  header: boolean;
}

/**
 * Group scripts into the ordered sections the sidebar renders.
 *
 * Uncategorised scripts normally trail the categories with no header of their
 * own. Sorting A→Z is the exception: pinning them last would mean the toggle
 * changes nothing at all for a library where every category holds one script,
 * so they become an "Other" section that sorts among the rest by its label.
 *
 * `favorites` is an ordered list of ids, and it wins over everything else: they
 * lead, in *their* order (never re-sorted — the position is the ⌘-number, so
 * the A→Z toggle must not move it), and they are pulled out of their categories
 * rather than shown twice. Ids with no matching script are ignored.
 *
 * `scripts` is expected to already be sorted when `sortAlpha` is set — sections
 * inherit that order, this function only decides the order *between* them.
 *
 * Exported for tests.
 */
export function buildSections(
  scripts: ScriptEntry[],
  sortAlpha: boolean,
  favorites: string[] = [],
): Section[] {
  const byCategory = new Map<string, ScriptEntry[]>();
  const order: string[] = [];
  const loose: ScriptEntry[] = [];
  const pinned = favorites
    .map((id) => scripts.find((s) => s.id === id))
    .filter((s): s is ScriptEntry => s !== undefined);
  const isPinned = new Set(pinned.map((s) => s.id));

  for (const s of scripts) {
    if (isPinned.has(s.id)) {
      continue;
    }
    if (s.category) {
      if (!byCategory.has(s.category)) {
        byCategory.set(s.category, []);
        order.push(s.category);
      }
      byCategory.get(s.category)!.push(s);
    } else {
      loose.push(s);
    }
  }

  const named: Section[] = order.map((cat) => ({
    key: cat,
    label: cat,
    items: byCategory.get(cat)!,
    header: true,
  }));

  const withFavorites = (sections: Section[]): Section[] =>
    pinned.length > 0
      ? [{ key: FAVORITES, label: "Favorites", items: pinned, header: true }, ...sections]
      : sections;

  if (!sortAlpha) {
    return withFavorites(
      loose.length > 0
        ? [...named, { key: UNGROUPED, label: OTHER_LABEL, items: loose, header: false }]
        : named,
    );
  }

  if (loose.length > 0) {
    // A manifest may already declare a category called "Other"; merging into it
    // beats rendering two sections under the same heading.
    const existing = named.find((s) => s.label.toLowerCase() === OTHER_LABEL.toLowerCase());
    if (existing) {
      existing.items = [...existing.items, ...loose].sort(byName);
    } else {
      named.push({ key: UNGROUPED, label: OTHER_LABEL, items: loose, header: true });
    }
  }
  return withFavorites(named.sort((a, b) => byLabel(a.label, b.label)));
}

interface SidebarProps {
  scripts: ScriptEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onImport: () => void;
  onImportFile: () => void;
  onImportPath?: (path: string) => void;
  recentImports: string[];
  onRelink: (id: string) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onExportPresets: (id: string) => void;
  onImportPresets: (id: string) => void;
  onRebuildEnv: (id: string) => void;
  onRefreshScript: (id: string) => void;
  runningScripts: string[];
  loading: boolean;
  view: "script" | "settings";
  onOpenSettings: () => void;
  /** Pinned script ids, in ⌘1…⌘9 order. */
  favorites: string[];
  onToggleFavorite: (id: string) => void;
}

export function Sidebar({ scripts, selectedId, onSelect, onImport, onImportFile, onImportPath, recentImports, onRelink, onRemove, onDuplicate, onExportPresets, onImportPresets, onRebuildEnv, onRefreshScript, runningScripts, loading, view, onOpenSettings, favorites, onToggleFavorite }: SidebarProps) {
  const [relinking, setRelinking] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [menu, setMenu] = useState<{ x: number; y: number; script: ScriptEntry } | null>(null);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sortAlpha, setSortAlpha] = useState(false);
  const [recentMenu, setRecentMenu] = useState<{ x: number; y: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { notify, notifyError } = useToast();

  useEscape(confirmDelete !== null, () => setConfirmDelete(null));

  // ⌘F focuses the search input (Plan.md §1.4). The shortcut itself belongs to
  // Edit ▸ Find Script in the native menu — see src-tauri/src/menu.rs.
  useMenuAction((action) => {
    if (action !== "find") return;
    searchRef.current?.focus();
    searchRef.current?.select();
  });

  // Filter scripts by search query (case-insensitive name match).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result = q ? scripts.filter((s) => s.name.toLowerCase().includes(q)) : scripts;
    return sortAlpha ? result.slice().sort(byName) : result;
  }, [scripts, search, sortAlpha]);

  const sections = useMemo(
    () => buildSections(filtered, sortAlpha, favorites),
    [filtered, sortAlpha, favorites],
  );

  // Flat ordered list of visible (non-collapsed) script IDs for arrow navigation.
  const flatIds = useMemo(() => {
    const ids: string[] = [];
    for (const section of sections) {
      if (section.header && collapsed.has(section.key)) continue;
      for (const s of section.items) ids.push(s.id);
    }
    return ids;
  }, [sections, collapsed]);

  const navigate = useCallback((direction: 1 | -1) => {
    if (flatIds.length === 0) return;
    const idx = selectedId ? flatIds.indexOf(selectedId) : -1;
    const next = Math.max(0, Math.min(flatIds.length - 1, idx + direction));
    onSelect(flatIds[next]);
  }, [flatIds, selectedId, onSelect]);

  // Arrow-key navigation, but only when the arrows are genuinely free: inside a
  // text field, a <select> or a dialog they belong to whatever is focused. The
  // sidebar's own search box is the exception — it forwards them below, so
  // typing a query and arrowing into the results works.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || hasOverlay()) return;
      e.preventDefault();
      navigate(e.key === "ArrowDown" ? 1 : -1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate]);

  const toggleCategory = (cat: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  const renderScriptRow = (s: ScriptEntry) => {
    const isRunning = runningScripts.includes(s.id);
    const favIndex = favorites.indexOf(s.id);
    return (
      <div
        key={s.id}
        class={`group mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
          s.id === selectedId
            ? "bg-accent text-white shadow-sm"
            : "text-fg hover:bg-fg/[0.06]"
        } ${!s.reachable ? "opacity-60" : ""}`}
        title={!s.reachable ? "File is missing — click Find to relink" : s.name}
        onClick={() => onSelect(s.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, script: s });
        }}
      >
        {isRunning && (
          <span
            class={`h-1.5 w-1.5 shrink-0 rounded-full ${
              s.id === selectedId ? "bg-white" : "bg-ok"
            } animate-pulse`}
            title="Running"
          />
        )}
        <ScriptIcon icon={s.icon} size={15} class="shrink-0" />
        <span class="flex-1 truncate">{s.name}</span>
        {/* The number is the shortcut, so it is shown rather than explained.
            Only the first nine get one — pinning a tenth script is allowed. */}
        {favIndex >= 0 && favIndex < 9 && (
          <span
            class={`shrink-0 text-2xs tabular-nums group-hover:hidden ${
              s.id === selectedId ? "text-white/70" : "text-subtle"
            }`}
            title={`Select with ⌘${favIndex + 1}`}
          >
            ⌘{favIndex + 1}
          </span>
        )}
        {/* ⇧⌘F acts on the *selected* script, so only that row advertises it. */}
        <button
          class={`shrink-0 rounded px-1 py-0.5 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 ${
            s.id === selectedId
              ? "text-white hover:bg-white/25"
              : favIndex >= 0
                ? "text-warn hover:bg-fg/10"
                : "text-subtle hover:bg-fg/10 hover:text-fg"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(s.id);
          }}
          title={
            favIndex >= 0
              ? "Unpin from Favorites"
              : `Pin to Favorites${s.id === selectedId ? " (⇧⌘F)" : ""}`
          }
          aria-label={favIndex >= 0 ? `Unpin ${s.name}` : `Pin ${s.name}`}
          aria-pressed={favIndex >= 0}
        >
          <StarIcon size={12} filled={favIndex >= 0} />
        </button>
        {!s.reachable && (
          <button
            class={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium ${
              s.id === selectedId
                ? "bg-white/25 text-white"
                : "bg-warn text-white hover:opacity-85"
            }`}
            onClick={(e) => handleRelink(e, s.id)}
            disabled={relinking === s.id}
            title="Find file"
          >
            {relinking === s.id ? "…" : "Find"}
          </button>
        )}
        <button
          class={`shrink-0 rounded px-1 py-0.5 text-2xs opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 ${
            s.id === selectedId
              ? "text-white hover:bg-white/25"
              : "text-subtle hover:bg-danger hover:text-white"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDelete(s.id);
          }}
          title="Remove script"
          aria-label={`Remove ${s.name}`}
        >
          <CloseIcon size={12} />
        </button>
      </div>
    );
  };

  /** Folder actions all resolve the path in Rust from the script list. */
  const folderActions = (script: ScriptEntry): MenuItem[] => [
    {
      label: favorites.includes(script.id) ? "Unpin from Favorites" : "Pin to Favorites",
      icon: <StarIcon filled={favorites.includes(script.id)} />,
      onSelect: () => onToggleFavorite(script.id),
    },
    {
      label: "Refresh",
      separated: true,
      icon: <RefreshIcon />,
      onSelect: () => onRefreshScript(script.id),
    },
    {
      label: "Copy path",
      icon: <FolderIcon />,
      onSelect: async () => {
        try {
          const dir = await ipc<string>("script_folder", { scriptId: script.id });
          await writeText(dir);
          notify("info", `Copied ${dir}`);
        } catch (e) {
          notifyError(e, "Copy path failed");
        }
      },
    },
    {
      label: "Open in PyCharm",
      icon: <EditorIcon />,
      onSelect: async () => {
        try {
          await ipc("open_in_pycharm", { scriptId: script.id });
        } catch (e) {
          notifyError(e, "Open in PyCharm failed");
        }
      },
    },
    {
      label: "Open in Terminal",
      icon: <TerminalIcon />,
      onSelect: async () => {
        try {
          await ipc("open_in_terminal", { scriptId: script.id });
        } catch (e) {
          notifyError(e, "Open in Terminal failed");
        }
      },
    },
    { label: "Duplicate", separated: true, onSelect: () => onDuplicate(script.id) },
    { label: "Export presets…", onSelect: () => onExportPresets(script.id) },
    { label: "Import presets…", onSelect: () => onImportPresets(script.id) },
    {
      label: "Rebuild env",
      icon: <RefreshIcon />,
      separated: true,
      onSelect: () => onRebuildEnv(script.id),
    },
  ];

  const handleRelink = async (e: Event, scriptId: string) => {
    e.stopPropagation();
    setRelinking(scriptId);
    try {
      const selected = await open({
        filters: [{ name: "Python", extensions: ["py"] }],
        multiple: false,
      });
      if (selected && typeof selected === "string") {
        await ipc("relink_script", { scriptId, newPath: selected });
        onRelink(scriptId);
      }
    } catch (err) {
      notifyError(err, "Relink failed");
    } finally {
      setRelinking(null);
    }
  };

  const handleRemove = async (scriptId: string) => {
    try {
      await ipc("remove_script", { scriptId, deleteEnv: true });
      onRemove(scriptId);
    } catch (err) {
      notifyError(err, "Remove failed");
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <div class="vibrancy flex h-full w-64 shrink-0 flex-col border-r border-line">
      {/* Titlebar band: the window is frameless (titleBarStyle: Overlay), so the
          traffic lights float over this corner and this strip has to be draggable. */}
      <div data-tauri-drag-region class="flex items-center gap-1 px-3 pb-2 pt-8">
        <span class="panel-title flex-1">Scripts</span>
        <button
          class="btn btn-secondary"
          onClick={onImport}
          title="Import a folder with pyshell.yaml"
        >
          + Folder
        </button>
        <button
          class="btn btn-secondary"
          onClick={onImportFile}
          title="Import a single .py file"
        >
          + File
        </button>
        {recentImports.length > 0 && (
          <button
            class="btn btn-secondary px-2"
            onClick={(e) => setRecentMenu({ x: e.currentTarget.getBoundingClientRect().right, y: e.currentTarget.getBoundingClientRect().bottom + 4 })}
            title="Recently imported paths"
          >
            <ClockIcon size={13} />
          </button>
        )}
      </div>
      {/* Search input (⌘F) with the sort toggle on the same row — on its own it
          took a whole extra line of a 256px-wide column for one small control. */}
      <div class="flex items-center gap-1.5 px-2 pb-1.5">
        <div class="relative min-w-0 flex-1">
          <SearchIcon size={13} class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            ref={searchRef}
            type="text"
            class="form-input w-full pl-7 pr-7 py-1 text-[13px]"
            placeholder="Search…"
            value={search}
            onInput={(e) => setSearch(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setSearch(""); (e.target as HTMLInputElement).blur(); }
              if (e.key === "ArrowDown") { e.preventDefault(); navigate(1); }
              if (e.key === "ArrowUp") { e.preventDefault(); navigate(-1); }
            }}
          />
          {search && (
            <button
              class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-fg"
              onClick={() => { setSearch(""); searchRef.current?.focus(); }}
              title="Clear search"
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>
        {/* Active state is btn-primary, matching the Docs and Settings toggles —
            a colour swap on a secondary button read as "disabled", not "on". */}
        <button
          class={`btn ${sortAlpha ? "btn-primary" : "btn-secondary"} shrink-0 self-stretch px-1.5`}
          onClick={() => setSortAlpha((v) => !v)}
          title={sortAlpha ? "Sorted A→Z — click for import order" : "Sort A→Z"}
          aria-pressed={sortAlpha}
          aria-label="Sort scripts alphabetically"
        >
          <SortIcon size={13} />
        </button>
      </div>

      <div ref={listRef} class="flex-1 overflow-y-auto px-2 pb-2">
        {loading && <div class="p-2 text-2xs text-subtle">Loading…</div>}
        {!loading && scripts.length === 0 && (
          <div class="mx-1 mt-1 rounded-lg border border-dashed border-line p-3 text-2xs leading-relaxed text-subtle">
            No scripts yet. Use <span class="font-medium text-muted">+ Folder</span> for a project
            with a <span class="font-mono">pyshell.yaml</span>, or{" "}
            <span class="font-medium text-muted">+ File</span> for a single script.
            <div class="mt-2 border-t border-line pt-2">
              Need something to run? Ready-made scripts live at{" "}
              <ExternalLink href={SCRIPTS_URL}>
                PyShell-scripts
              </ExternalLink>
              .
            </div>
          </div>
        )}
        {!loading && scripts.length > 0 && filtered.length === 0 && (
          <div class="p-2 text-2xs text-subtle">No scripts match "{search}".</div>
        )}

        {sections.map((section) => {
          // The headerless section is the uncategorised tail in insertion order:
          // it has nothing to collapse and nothing to name.
          if (!section.header) return section.items.map((s) => renderScriptRow(s));
          const isCollapsed = collapsed.has(section.key);
          return (
            <div key={section.key} class="mb-1">
              <button
                class="group flex w-full items-center gap-1 rounded px-1.5 py-1 text-2xs font-semibold uppercase tracking-wider text-subtle hover:text-muted"
                onClick={() => toggleCategory(section.key)}
                aria-expanded={!isCollapsed}
              >
                <ChevronIcon
                  size={11}
                  class={`transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                />
                {section.key === FAVORITES && <StarIcon size={10} filled class="text-warn" />}
                <span class="truncate">{section.label}</span>
                <span class="ml-auto text-subtle/60">{section.items.length}</span>
              </button>
              {!isCollapsed && section.items.map((s) => renderScriptRow(s))}
            </div>
          );
        })}
      </div>

      <div class="shrink-0 border-t border-line px-3 py-2.5">
        <div class="flex items-center gap-2">
          {runningScripts.length > 0 && (
            <span
              class="flex items-center gap-1.5 rounded-full bg-ok/12 px-2 py-0.5 text-2xs font-medium text-ok"
              title={`${runningScripts.length} run${runningScripts.length === 1 ? "" : "s"} in progress`}
            >
              <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
              {runningScripts.length} running
            </span>
          )}
          <span class="flex-1" />
          <button
            class={`btn ${view === "settings" ? "btn-primary" : "btn-secondary"} px-2`}
            onClick={onOpenSettings}
            title="Settings (⌘,)"
            aria-pressed={view === "settings"}
          >
            <GearIcon size={14} />
          </button>
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={folderActions(menu.script)}
          onClose={() => setMenu(null)}
        />
      )}

      {recentMenu && (
        <ContextMenu
          x={recentMenu.x}
          y={recentMenu.y}
          items={recentImports.map((p) => ({
            label: p.split(/[/\\]/).pop() ?? p,
            onSelect: () => {
              onImportPath?.(p);
              setRecentMenu(null);
            },
          }))}
          onClose={() => setRecentMenu(null)}
        />
      )}

      {confirmDelete && (
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setConfirmDelete(null)}>
          <div
            class="max-w-sm rounded-xl border border-line bg-raised p-5 shadow-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="mb-1.5 text-[15px] font-semibold">Remove script?</h2>
            <p class="mb-4 text-[13px] leading-relaxed text-muted">
              This removes the script from PyShell and deletes its virtual environment. The script
              file on disk is not touched.
            </p>
            <div class="flex justify-end gap-2">
              <button class="btn btn-secondary" autoFocus onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button class="btn btn-danger" onClick={() => handleRemove(confirmDelete)}>
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
