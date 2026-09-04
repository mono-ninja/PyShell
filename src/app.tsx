import { useState, useCallback, useEffect, useMemo, useRef } from "preact/hooks";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "./lib/ipc";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { LogView } from "./components/LogView/LogView";
import { FormRenderer } from "./components/Form/FormRenderer";
import { ResultView } from "./components/ResultView/ResultView";
import { isFormValid, validateForm, deepEqual } from "./components/Form/field-utils";
import { useScripts } from "./hooks/useScripts";
import { useJobs } from "./hooks/useJobs";
import { useTheme } from "./hooks/useTheme";
import type { JobState, StructuredState } from "./hooks/useJobs";
import { useToast } from "./components/Toast";
import { ContextMenu } from "./components/ContextMenu";

const EMPTY_STRUCTURED: StructuredState = { progress: null, table: null, status: null, markdown: null, chart: null };
import type { ScriptSchema, EnvStatus, ScriptState, HistoryEntry, Preset, ScriptDoc, ScriptEntry } from "./types/schema";
import { ReadmePanel } from "./components/ReadmePanel";
import { Tabs } from "./components/Tabs";
import type { TabDef } from "./components/Tabs";
import { RunStatusBar } from "./components/RunStatusBar";
import { useArtifacts } from "./hooks/useArtifacts";
import { useFavorites } from "./hooks/useFavorites";
import { useMenuAction } from "./hooks/useMenuAction";
import { useStoreUpdates } from "./hooks/useStoreUpdates";
import { missingNeeds } from "./lib/needs";
import { ScriptingGuide } from "./components/ScriptingGuide";
import { StoreDialog } from "./components/StoreDialog";
import { useEscape } from "./lib/keyboard";
import { BookIcon, CheckIcon, CloseIcon, PlayIcon, SearchIcon, StopIcon, TrashIcon } from "./components/icons";
import { ScriptIcon } from "./lib/script-icon";
import { Settings } from "./components/Settings/Settings";

interface EnvProgress {
  phase: string;
  pct: number;
  message: string;
}

const ONBOARDING_KEY = "pyshell:onboarded";
const RECENT_KEY = "pyshell:recent-imports";

function loadRecentImports(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveRecentImport(path: string) {
  try {
    const recent = loadRecentImports().filter((p) => p !== path);
    recent.unshift(path);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 5)));
  } catch { /* ignore */ }
}
type PaneId = "params" | "output" | "results" | "history";
type View = "script" | "settings";

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

export function App() {
  const { theme, setTheme } = useTheme();
  const { notify, notifyError } = useToast();
  const { scripts, loading, refresh } = useScripts();
  const { favorites, toggleFavorite } = useFavorites(scripts, notifyError);
  const { jobs, run, cancel, clearJob, runningScripts } = useJobs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [schema, setSchema] = useState<ScriptSchema | null>(null);
  const [envStatus, setEnvStatus] = useState<EnvStatus | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [autoScroll, setAutoScroll] = useState(true);
  const [envProgress, setEnvProgress] = useState<EnvProgress | null>(null);
  const [showConsent, setShowConsent] = useState(false);
  const [introspecting, setIntrospecting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [scriptState, setScriptState] = useState<ScriptState | null>(null);
  const [showDepsConfirm, setShowDepsConfirm] = useState(false);
  const [depsList, setDepsList] = useState<string[]>([]);
  const [presetName, setPresetName] = useState("");
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [presetMenu, setPresetMenu] = useState<{ x: number; y: number; preset: Preset } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [scriptCode, setScriptCode] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [showStore, setShowStore] = useState(false);
  const [readme, setReadme] = useState<ScriptDoc | null>(null);
  const [pane, setPane] = useState<PaneId>("params");
  // Content that landed while its tab was hidden, so the tab can say so.
  const [unseen, setUnseen] = useState<Set<PaneId>>(new Set());
  const [showReadme, setShowReadme] = useState(false);
  const [view, setView] = useState<View>("script");
  const [showCmdPreview, setShowCmdPreview] = useState(false);
  const [cmdPreview, setCmdPreview] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [compareBase, setCompareBase] = useState<number | null>(null);
  const [compareDiff, setCompareDiff] = useState<{ base: HistoryEntry; target: HistoryEntry } | null>(null);
  const [historySearch, setHistorySearch] = useState("");
  const [recentImports, setRecentImports] = useState<string[]>(loadRecentImports);
  // Dot on "+ Store": installed scripts with a newer version in the catalog.
  const storeUpdates = useStoreUpdates(scripts, showStore);

  useEffect(() => {
    if (!localStorage.getItem(ONBOARDING_KEY)) {
      setShowOnboarding(true);
    }
  }, []);

  const dismissOnboarding = useCallback(() => {
    localStorage.setItem(ONBOARDING_KEY, "1");
    setShowOnboarding(false);
  }, []);

  // Ref to avoid race conditions when switching scripts (audit #8, H7)
  const selectedIdRef = useRef(selectedId);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  // Token ref to prevent stale async setState in selectScript (audit H7)
  const selectTokenRef = useRef(0);

  // Listen for manifest changes (Plan.md §M3: watcher → scripts:changed)
  useEffect(() => {
    const unlisten = listen("scripts:changed", () => {
      const id = selectedIdRef.current;
      // Always refresh the script list: a manifest edit may have changed
      // schema_error (Plan.md §0), and that lives on the entry, not the schema.
      refresh();
      if (id) {
        ipc<ScriptSchema>("reload_schema", { scriptId: id })
          .then((s) => {
            if (selectedIdRef.current === id) setSchema(s);
            // reload_schema syncs name/icon/category into the script list
            // entry; re-fetch the list so the sidebar picks up the change.
            refresh();
          })
          .catch((e) => {
            notifyError(e, "Manifest reload failed");
          });
        // Re-check env status: a requirements.txt or pyshell.yaml edit may
        // have changed the env_key, flipping the pill from Ready to Stale.
        ipc<EnvStatus>("env_status", { scriptId: id })
          .then((status) => {
            if (selectedIdRef.current === id) setEnvStatus(status);
          })
          .catch((e) => {
            notifyError(e, "Env status check failed");
          });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh, notifyError]);

  // Listen for env progress events (Plan.md §M2: env:{id}:progress)
  useEffect(() => {
    if (!selectedId) return;
    const id = selectedId;
    const unlisten = listen(`env:${id}:progress`, (event) => {
      if (selectedIdRef.current !== id) return;
      const p = event.payload as EnvProgress;
      setEnvProgress(p);
      if (p.phase === "done") {
        setTimeout(() => setEnvProgress(null), 1500);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [selectedId]);

  const formValid = useMemo(
    () => (schema ? isFormValid(schema.inputs, values) : false),
    [schema, values],
  );

  const errorCount = useMemo(() => {
    if (!schema) return 0;
    return Object.keys(validateForm(schema.inputs, values)).length;
  }, [schema, values]);

  // Manifest-declared dependencies that no imported script carries — shown as
  // a warn pill in the header (satisfied ones are deliberately invisible).
  const missing = useMemo(
    () => (schema ? missingNeeds(schema.needs, scripts) : []),
    [schema, scripts],
  );

  const handleResetDefaults = useCallback(() => {
    if (!schema) return;
    const defaults: Record<string, unknown> = {};
    for (const input of schema.inputs) {
      if (input.default !== undefined && input.default !== null) {
        defaults[input.key] = input.default;
      }
    }
    setValues(defaults);
    setActivePreset(null);
  }, [schema]);

  const jumpToFirstError = useCallback(() => {
    if (!schema) return;
    const errors = validateForm(schema.inputs, values);
    const firstInvalid = schema.inputs.find((i) => errors[i.key]);
    if (firstInvalid) {
      const el = document.getElementById(`field-${firstInvalid.key}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus();
      }
    }
  }, [schema, values]);

  const handlePreviewCommand = useCallback(async () => {
    if (!selectedId) return;
    try {
      const preview = await ipc<{ command: string; env: Record<string, string> }>(
        "preview_command",
        { scriptId: selectedId, values },
      );
      setCmdPreview(preview.command);
      setShowCmdPreview(true);
    } catch (e) {
      notifyError(e, "Command preview failed");
    }
  }, [selectedId, values, notifyError]);

  const selectScript = useCallback(async (id: string) => {
    const token = ++selectTokenRef.current;
    setView("script");
    setSelectedId(id);
    setSchema(null);
    setEnvStatus(null);
    setValues({});
    setScriptState(null);
    setEnvProgress(null);
    setReadme(null);
    setShowReadme(false);
    setPane("params");
    setUnseen(new Set());
    setActivePreset(null);
    try {
      const s = await ipc<ScriptSchema>("get_schema", { scriptId: id });
      if (selectTokenRef.current !== token) return; // stale
      setSchema(s);
      const defaults: Record<string, unknown> = {};
      for (const input of s.inputs) {
        if (input.default !== undefined && input.default !== null) {
          defaults[input.key] = input.default;
        }
      }
      setValues(defaults);
      const status = await ipc<EnvStatus>("env_status", { scriptId: id });
      if (selectTokenRef.current !== token) return; // stale
      setEnvStatus(status);
      const state = await ipc<ScriptState>("get_state", { scriptId: id });
      if (selectTokenRef.current !== token) return; // stale
      setScriptState(state);
      // Best-effort: a script with no README is the common case, and a failure
      // here must not stop the form from loading.
      ipc<ScriptDoc | null>("script_readme", { scriptId: id })
        .then((doc) => {
          if (selectTokenRef.current === token) setReadme(doc);
        })
        .catch((e) => notifyError(e, "Readme load failed"));
      if (state.last_values && Object.keys(state.last_values).length > 0) {
        // Filter last_values to only keys present in current schema (audit M11)
        const validKeys = new Set(s.inputs.map((i) => i.key));
        const filtered = Object.fromEntries(
          Object.entries(state.last_values).filter(([k]) => validKeys.has(k))
        );
        setValues({ ...defaults, ...filtered });
      }
    } catch (e) {
      notifyError(e, "Failed to load script");
    }
  }, [notifyError]);

  // Re-fetch the same document in another language. The backend falls back to
  // the default variant if the code no longer resolves, so a deleted
  // translation degrades to the default rather than blanking the panel.
  const selectReadmeLang = useCallback(
    (lang: string | null) => {
      if (!selectedId) return;
      ipc<ScriptDoc | null>("script_readme", { scriptId: selectedId, lang })
        .then((doc) => setReadme(doc))
        .catch((e) => notifyError(e, "Readme load failed"));
    },
    [selectedId, notifyError],
  );

  const handleImport = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select a script folder",
      });
      if (selected && typeof selected === "string") {
        await ipc("import_script", { path: selected });
        saveRecentImport(selected);
        setRecentImports(loadRecentImports());
        await refresh();
      }
    } catch (e) {
      notifyError(e, "Import failed");
    }
  }, [refresh, notifyError]);

  const handleImportFile = useCallback(async () => {
    try {
      const selected = await open({
        filters: [{ name: "Python", extensions: ["py"] }],
        multiple: false,
        title: "Select a .py file",
      });
      if (selected && typeof selected === "string") {
        await ipc("import_script", { path: selected });
        saveRecentImport(selected);
        setRecentImports(loadRecentImports());
        await refresh();
      }
    } catch (e) {
      notifyError(e, "Import failed");
    }
  }, [refresh, notifyError]);

  const handleImportPath = useCallback(async (path: string) => {
    try {
      await ipc("import_script", { path });
      saveRecentImport(path);
      setRecentImports(loadRecentImports());
      await refresh();
    } catch (e) {
      notifyError(e, "Import failed");
    }
  }, [refresh, notifyError]);

  // A Store install already imported on the Rust side; this only stitches it
  // into the UI the way the local imports above do. The recent-imports menu
  // lists folders, so the entry .py's parent is what gets remembered.
  const handleStoreInstalled = useCallback((entry: ScriptEntry) => {
    const folder = entry.path.split(/[/\\]/).slice(0, -1).join("/");
    if (folder) saveRecentImport(folder);
    setRecentImports(loadRecentImports());
    refresh();
    setView("script");
    selectScript(entry.id);
  }, [refresh, selectScript]);

  const handleRun = useCallback(async () => {
    if (!selectedId) return;
    try {
      await run(selectedId, values);
      await ipc("save_last_values", { scriptId: selectedId, values });
    } catch (e) {
      notifyError(e, "Run failed");
    }
  }, [selectedId, values, run, notifyError]);

  const handleCancel = useCallback(() => {
    setShowCancelConfirm(true);
  }, []);

  const doCancel = useCallback(async () => {
    setShowCancelConfirm(false);
    if (selectedId) {
      await cancel(selectedId);
    }
  }, [selectedId, cancel]);

  const handlePrepareEnv = useCallback(async (scriptId?: string) => {
    const id = scriptId ?? selectedId;
    if (!id || preparing) return;
    try {
      const deps = await ipc<string[]>("list_dependencies", { scriptId: id });
      if (deps.length > 0) {
        setDepsList(deps);
        setShowDepsConfirm(true);
      } else {
        await doPrepareEnv(id);
      }
    } catch (e) {
      notifyError(e, "Failed to list dependencies");
      await doPrepareEnv(id);
    }
  }, [selectedId, preparing]);

  const doPrepareEnv = useCallback(async (scriptId?: string) => {
    const id = scriptId ?? selectedId;
    if (!id || preparing) return;
    setShowDepsConfirm(false);
    // envStatus stays "missing" for the whole build, so without this flag the
    // Prepare Env button stays live and a second click starts a second
    // `uv venv` against the same directory.
    setPreparing(true);
    try {
      await ipc("prepare_env", { scriptId: id });
    } catch (e) {
      notifyError(e, "Environment setup failed");
    } finally {
      setPreparing(false);
      // Refresh either way: on failure the backend has recorded
      // EnvStatus::Failed, which is what the banner should show.
      try {
        const status = await ipc<EnvStatus>("env_status", { scriptId: id });
        if (selectedIdRef.current === id) setEnvStatus(status);
      } catch (e) {
        notifyError(e, "Env status check failed");
      }
    }
  }, [selectedId, preparing, notifyError]);

  // Rebuild env from the sidebar context menu. Selects the script first so the
  // user sees env progress in the main pane, then triggers the same prepare-env
  // flow as the header button — with an explicit scriptId so the stale-closure
  // over selectedId is not an issue.
  const handleRebuildEnv = useCallback(async (scriptId: string) => {
    await selectScript(scriptId);
    await handlePrepareEnv(scriptId);
  }, [selectScript, handlePrepareEnv]);

  // Refresh a script's metadata (name, icon, category, schema) from its
  // manifest on disk. Works for any script, not just the selected one.
  const handleRefreshScript = useCallback(async (scriptId: string) => {
    try {
      const s = await ipc<ScriptSchema>("reload_schema", { scriptId });
      if (selectedIdRef.current === scriptId) setSchema(s);
      // reload_schema syncs name/icon/category into the script list entry;
      // re-fetch the list so the sidebar picks up the change.
      await refresh();
      // Re-check env status too: requirements or python may have changed.
      const status = await ipc<EnvStatus>("env_status", { scriptId });
      if (selectedIdRef.current === scriptId) setEnvStatus(status);
    } catch (e) {
      notifyError(e, "Refresh failed");
    }
  }, [refresh, notifyError]);

  const handleRelink = useCallback(async (id: string) => {
    await refresh();
    if (selectedIdRef.current === id) {
      try {
        const s = await ipc<ScriptSchema>("get_schema", { scriptId: id });
        if (selectedIdRef.current !== id) return;
        setSchema(s);
        const status = await ipc<EnvStatus>("env_status", { scriptId: id });
        if (selectedIdRef.current !== id) return;
        setEnvStatus(status);
      } catch (e) {
        notifyError(e, "Relink reload failed");
      }
    }
  }, [refresh, notifyError]);

  const handleRemove = useCallback(async (id: string) => {
    // Cancel running job before removing (audit H11 — prevent orphaned process)
    await cancel(id);
    if (selectedIdRef.current === id) {
      setSelectedId(null);
      setSchema(null);
      setEnvStatus(null);
    }
    clearJob(id);
    await refresh();
  }, [refresh, clearJob, cancel]);

  const handleSavePreset = useCallback(async () => {
    if (!selectedId || !presetName.trim()) return;
    const name = presetName.trim();
    try {
      await ipc("save_preset", { scriptId: selectedId, name, values });
      const state = await ipc<ScriptState>("get_state", { scriptId: selectedId });
      setScriptState(state);
      setPresetName("");
      setActivePreset(name);
    } catch (e) {
      notifyError(e, "Save preset failed");
    }
  }, [selectedId, presetName, values, notifyError]);

  const handleLoadPreset = useCallback(async (preset: Preset) => {
    // Merge with schema defaults so new fields not in preset get their default (audit M15)
    const defaults: Record<string, unknown> = {};
    if (schema) {
      for (const input of schema.inputs) {
        if (input.default !== undefined && input.default !== null) {
          defaults[input.key] = input.default;
        }
      }
    }
    setValues({ ...defaults, ...preset.values });
    setActivePreset(preset.name);
  }, [schema]);

  const handleDeletePreset = useCallback(async (name: string) => {
    if (!selectedId) return;
    try {
      await ipc("delete_preset", { scriptId: selectedId, name });
      const state = await ipc<ScriptState>("get_state", { scriptId: selectedId });
      setScriptState(state);
      if (activePreset === name) setActivePreset(null);
      notify("info", `Deleted preset “${name}”`);
    } catch (e) {
      notifyError(e, "Delete preset failed");
    }
  }, [selectedId, activePreset, notify, notifyError]);

  const handleRenamePreset = useCallback(async (oldName: string, newName: string) => {
    if (!selectedId || !newName.trim() || newName.trim() === oldName) {
      setRenaming(null);
      return;
    }
    try {
      await ipc("rename_preset", { scriptId: selectedId, oldName, newName: newName.trim() });
      const state = await ipc<ScriptState>("get_state", { scriptId: selectedId });
      setScriptState(state);
      if (activePreset === oldName) setActivePreset(newName.trim());
    } catch (e) {
      notifyError(e, "Rename preset failed");
    } finally {
      setRenaming(null);
    }
  }, [selectedId, activePreset, notifyError]);

  const handleShowCode = useCallback(async () => {
    if (!selectedId || !schema) return;
    try {
      const content = await readTextFile(schema.runtime.entry);
      setScriptCode(content);
      setShowCode(true);
    } catch (e) {
      notifyError(e, "Could not read script");
      setScriptCode(null);
      setShowCode(false);
    }
  }, [selectedId, schema, notifyError]);

  const handleDuplicate = useCallback(async (scriptId: string) => {
    try {
      await ipc("duplicate_script", { scriptId });
      await refresh();
      notify("info", "Script duplicated");
    } catch (e) {
      notifyError(e, "Duplicate failed");
    }
  }, [refresh, notify, notifyError]);

  const handleExportPresets = useCallback(async (scriptId: string) => {
    try {
      const state = await ipc<ScriptState>("get_state", { scriptId });
      if (state.presets.length === 0) {
        notify("info", "This script has no presets to export");
        return;
      }
      const dest = await save({
        defaultPath: `${scriptId}-presets.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (dest) {
        await writeTextFile(dest, JSON.stringify({ presets: state.presets }, null, 2));
        notify("info", `Exported ${state.presets.length} presets`);
      }
    } catch (e) {
      notifyError(e, "Export failed");
    }
  }, [notify, notifyError]);

  const handleImportPresets = useCallback(async (scriptId: string) => {
    try {
      const src = await open({
        filters: [{ name: "JSON", extensions: ["json"] }],
        multiple: false,
      });
      if (src && typeof src === "string") {
        const content = await readTextFile(src);
        const data = JSON.parse(content) as { presets: Preset[] };
        if (!data.presets || !Array.isArray(data.presets)) {
          notify("info", "Invalid presets file");
          return;
        }
        await ipc("import_presets", { scriptId, presets: data.presets });
        if (selectedId === scriptId && scriptState) {
          // Dedup by name: imported presets overwrite existing ones with the same
          // name, matching the backend's merge semantics (state.rs).
          const importedNames = new Set(data.presets.map((p) => p.name));
          const kept = scriptState.presets.filter((p) => !importedNames.has(p.name));
          setScriptState({ ...scriptState, presets: [...kept, ...data.presets] });
        }
        notify("info", `Imported ${data.presets.length} presets`);
      }
    } catch (e) {
      notifyError(e, "Import failed");
    }
  }, [selectedId, scriptState, notify, notifyError]);

  const handleIntrospect = useCallback(async () => {
    if (!selectedId) return;
    setShowConsent(false);
    setIntrospecting(true);
    try {
      const newSchema = await ipc<ScriptSchema>("introspect_script", { scriptId: selectedId });
      setSchema(newSchema);
      const defaults: Record<string, unknown> = {};
      for (const input of newSchema.inputs) {
        if (input.default !== undefined && input.default !== null) {
          defaults[input.key] = input.default;
        }
      }
      setValues(defaults);
    } catch (e) {
      notifyError(e, "Introspection failed");
    } finally {
      setIntrospecting(false);
    }
  }, [selectedId, notifyError]);

  const handleSaveManifest = useCallback(async () => {
    if (!selectedId) return;
    try {
      await ipc("save_generated_manifest", { scriptId: selectedId });
    } catch (e) {
      notifyError(e, "Save manifest failed");
    }
  }, [selectedId, notifyError]);

  const handleRetry = useCallback(async (entry: HistoryEntry) => {
    if (!selectedId) return;
    setValues(entry.values);
    await run(selectedId, entry.values);
  }, [selectedId, run]);

  // Open a past run's log file or its output directory in Finder (Plan.md §1.2).
  const handleOpenPastRun = useCallback(async (jobId: string, kind: "log" | "files") => {
    if (!selectedId) return;
    try {
      const dir = await ipc<string>("job_run_dir", { scriptId: selectedId, jobId });
      if (kind === "log") {
        await revealItemInDir(`${dir}/output.log`);
      } else {
        await openPath(dir);
      }
    } catch (e) {
      notifyError(e, "Could not open past run");
    }
  }, [selectedId, notifyError]);

  const handleCompare = useCallback((idx: number, entry: HistoryEntry) => {
    if (compareBase === null) {
      setCompareBase(idx);
    } else if (compareBase === idx) {
      setCompareBase(null);
    } else {
      const history = scriptState?.history ?? [];
      const reversed = history.slice().reverse();
      setCompareDiff({ base: reversed[compareBase], target: entry });
      setCompareBase(null);
    }
  }, [compareBase, scriptState]);

  const handleValueChange = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const envLabel = (() => {
    if (envProgress) return `${envProgress.message} (${envProgress.pct.toFixed(0)}%)`;
    if (!envStatus) return "";
    switch (envStatus.state) {
      case "ready":
        return `✓ Ready (${(envStatus.size_bytes / 1_048_576).toFixed(1)} MB)`;
      case "missing":
        return "⚠ Needs setup";
      case "stale":
        return "⚠ Stale — needs rebuild";
      case "building":
        return `Building… ${envStatus.pct.toFixed(0)}%`;
      case "failed":
        return `✗ ${envStatus.message}`;
      default:
        return "";
    }
  })();

  const envPillClass = (() => {
    if (envProgress || envStatus?.state === "building") return "bg-accent/12 text-accent";
    switch (envStatus?.state) {
      case "ready":
        return "bg-ok/12 text-ok";
      case "failed":
        return "bg-danger/12 text-danger";
      case "missing":
      case "stale":
        return "bg-warn/15 text-warn";
      default:
        return "text-subtle";
    }
  })();

  // Show the "Introspect" button for schemas that were guessed from PEP 723
  // metadata or produced as a bare fallback (no manifest). Schemas that came
  // from pyshell.yaml or were already introspected (source = "guessed") don't
  // need it (audit H12).
  const isGuessed = schema?.source === "pep723" || schema?.source === "fallback";
  const envReady = envStatus?.state === "ready";

  // A broken pyshell.yaml is recorded on the entry by the backend (Plan.md §0).
  // Shown as a banner so a silent degrade to a guessed form is no longer silent.
  const schemaError = selectedId
    ? (scripts.find((s) => s.id === selectedId)?.schema_error ?? null)
    : null;

  // Whether the current form values differ from the loaded preset (Plan.md §1.3).
  const presetModified = useMemo(() => {
    if (!activePreset || !scriptState) return false;
    const preset = scriptState.presets.find((p) => p.name === activePreset);
    if (!preset) return false;
    return !deepEqual(values, preset.values);
  }, [activePreset, scriptState, values]);

  const currentJob: JobState | null = selectedId ? (jobs[selectedId] ?? null) : null;
  const running = currentJob?.running ?? false;
  const otherRunningCount = runningScripts.filter((id) => id !== selectedId).length;
  const [showJobsPanel, setShowJobsPanel] = useState(false);
  const lines = currentJob?.lines ?? [];
  const exitInfo = currentJob?.exitInfo ?? null;
  const structured = currentJob?.structured ?? EMPTY_STRUCTURED;
  const currentJobId = currentJob?.jobId ?? null;
  const artifacts = useArtifacts(currentJobId, exitInfo);

  useEffect(() => {
    if (runningScripts.length === 0) setShowJobsPanel(false);
  }, [runningScripts.length]);

  const selectPane = useCallback((id: PaneId) => {
    setPane(id);
    setUnseen((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Jump to Output when a run starts — that is where the user is looking next,
  // and staying on the form hides the very thing they just triggered.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running && !wasRunning.current) selectPane("output");
    wasRunning.current = running;
  }, [running, selectPane]);

  // Flag Results when something arrives there while another tab is open.
  const hasResults = structured.table != null || structured.chart != null || structured.markdown != null || artifacts.length > 0;
  useEffect(() => {
    if (hasResults && pane !== "results") {
      setUnseen((prev) => (prev.has("results") ? prev : new Set(prev).add("results")));
    }
  }, [hasResults, pane]);

  const historyCount = scriptState?.history.length ?? 0;

  // History search. `idx` is kept as the index into the *full* reversed list
  // so Compare (which resolves `reversed[compareBase]`) stays correct even when
  // entries are filtered out of view.
  useEffect(() => setHistorySearch(""), [selectedId]);
  const filteredHistory = useMemo(() => {
    const reversed = (scriptState?.history ?? []).slice().reverse();
    const q = historySearch.trim().toLowerCase();
    if (!q) return reversed.map((entry, idx) => ({ entry, idx }));
    return reversed
      .map((entry, idx) => ({ entry, idx }))
      .filter(({ entry }) => historyHaystack(entry).includes(q));
  }, [scriptState, historySearch]);

  const panes: TabDef<PaneId>[] = [
    { id: "params", label: "Parameters", badge: schema?.inputs.length || null },
    { id: "output", label: "Output", badge: lines.length || null },
    { id: "results", label: "Results", badge: schema?.outputs.result && schema.outputs.result !== "none" ? schema.outputs.result : null, dot: unseen.has("results") },
    { id: "history", label: "History", badge: historyCount || null },
  ];

  // Any dialog that owns the keyboard while it is up. Menu shortcuts are
  // ignored then — ⌘↩ behind a modal would start a run the user cannot see —
  // and Escape is the way out (registered per dialog through `useEscape`).
  const dialogOpen =
    showConsent || showCode || showDepsConfirm || showOnboarding ||
    showCancelConfirm || renaming !== null || compareDiff !== null;

  // Keyboard shortcuts come from the native menu (src-tauri/src/menu.rs), not
  // from a `window` listener: on macOS a key equivalent claimed by the menu
  // never reaches the webview, so a second binding here would be dead code —
  // and a double-fire on the platforms where it isn't.
  useMenuAction((action) => {
    if (dialogOpen) return;
    switch (action) {
      case "run":
        if (!running && formValid && envReady) handleRun();
        break;
      case "cancel":
        if (running) handleCancel();
        break;
      case "preview":
        if (formValid && envReady) handlePreviewCommand();
        break;
      case "reset":
        if (!running) handleResetDefaults();
        break;
      case "docs":
        if (readme) setShowReadme((v) => !v);
        break;
      case "help:guide":
        setShowGuide(true);
        break;
      case "settings":
        setView((v) => (v === "settings" ? "script" : "settings"));
        break;
      case "import:file":
        handleImportFile();
        break;
      case "import:folder":
        handleImport();
        break;
      case "store:open":
        setShowStore(true);
        break;
      case "pane:params":
      case "pane:output":
      case "pane:results":
      case "pane:history":
        if (view === "script" && schema) selectPane(action.slice(5) as PaneId);
        break;
      case "favorite:toggle":
        if (selectedId) toggleFavorite(selectedId);
        break;
      default:
        // ⌘1…⌘9 arrive as the pinned script's own id, so the number never has
        // to be resolved twice — the menu already knows what it points at.
        if (action.startsWith("fav:")) {
          setView("script");
          selectScript(action.slice(4));
        }
    }
  });

  // Escape closes the innermost dialog. Ordering is handled by the stack in
  // lib/keyboard, so nested dialogs (Show Code over the consent prompt) peel
  // off one at a time instead of all at once.
  useEscape(showCode, () => setShowCode(false));
  useEscape(renaming !== null, () => setRenaming(null));
  useEscape(compareDiff !== null, () => setCompareDiff(null));
  useEscape(showCancelConfirm, () => setShowCancelConfirm(false));
  useEscape(showDepsConfirm, () => setShowDepsConfirm(false));
  useEscape(showConsent && !showCode, () => setShowConsent(false));
  useEscape(showOnboarding, dismissOnboarding);
  useEscape(showCmdPreview, () => setShowCmdPreview(false), false);
  useEscape(showJobsPanel, () => setShowJobsPanel(false));
  useEscape(showGuide, () => setShowGuide(false));
  useEscape(showStore, () => setShowStore(false));

  return (
    <div class="flex h-screen w-screen overflow-hidden bg-app text-fg">
      <Sidebar
        scripts={scripts}
        selectedId={selectedId}
        onSelect={selectScript}
        onImport={handleImport}
        onImportFile={handleImportFile}
        onImportPath={handleImportPath}
        onOpenStore={() => setShowStore(true)}
        storeUpdates={storeUpdates}
        recentImports={recentImports}
        onRelink={handleRelink}
        onRemove={handleRemove}
        onDuplicate={handleDuplicate}
        onExportPresets={handleExportPresets}
        onImportPresets={handleImportPresets}
        onRebuildEnv={handleRebuildEnv}
        onRefreshScript={handleRefreshScript}
        runningScripts={runningScripts}
        loading={loading}
        view={view}
        onOpenSettings={() => setView((v) => (v === "settings" ? "script" : "settings"))}
        favorites={favorites}
        onToggleFavorite={toggleFavorite}
      />
      <div class="flex-1 flex flex-col min-h-0 overflow-hidden">
        {view === "settings" ? (
          <Settings
            scripts={scripts}
            theme={theme}
            onThemeChange={setTheme}
          />
        ) : schema ? (
          <>
            <header
              data-tauri-drag-region
              class="flex shrink-0 items-center gap-3 border-b border-line px-5 pb-3 pt-8"
            >
              <div class="flex min-w-0 flex-1 items-center gap-2.5">
                <ScriptIcon icon={schema.icon} size={19} class="shrink-0" />
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <h1 class="truncate text-[15px] font-semibold leading-tight">{schema.name}</h1>
                    {schema.version && (
                      <span class="shrink-0 text-2xs text-subtle" title="Script version">v{schema.version}</span>
                    )}
                  </div>
                  {schema.description && !showReadme && (
                    <p class="truncate text-2xs text-subtle">{schema.description}</p>
                  )}
                </div>
                {schema.runtime.timeout && (
                  <span
                    class="pill shrink-0 bg-warn/12 text-warn"
                    title={`This script will be killed after ${schema.runtime.timeout}s unless it exits first`}
                  >
                    ⏱ {schema.runtime.timeout}s
                  </span>
                )}
                {isGuessed && (
                  <span class="pill shrink-0 bg-accent/12 text-accent" title={schema?.source === "pep723" ? "Schema inferred from PEP 723 metadata" : "No manifest found — schema is a bare fallback"}>
                    {schema?.source === "pep723" ? "PEP 723" : "Guessed"}
                  </span>
                )}
                {/* Only *missing* dependencies get a pill — a satisfied one is
                    business as usual, and needs-free scripts (the majority)
                    must not grow a new element in the header. */}
                {missing.length > 0 && (
                  <span
                    class="pill shrink-0 bg-warn/12 text-warn"
                    title={`This script expects other scripts to be installed: ${missing.join(", ")}. Install them from the Store (+ Store) — installed ones are passed to it as PYSHELL_DEPS.`}
                  >
                    Needs: {missing.length === 1 ? missing[0] : `${missing.length} scripts`}
                  </span>
                )}
              </div>

              {otherRunningCount > 0 && (
                <div class="relative shrink-0">
                  <button
                    class="pill shrink-0 bg-ok/12 text-ok hover:bg-ok/20 cursor-pointer"
                    title={`${otherRunningCount} other script${otherRunningCount === 1 ? "" : "s"} running in background — click to see all jobs`}
                    onClick={() => setShowJobsPanel((v) => !v)}
                  >
                    {otherRunningCount} running ▾
                  </button>
                  {showJobsPanel && (
                    <>
                      <div class="fixed inset-0 z-40" onClick={() => setShowJobsPanel(false)} />
                      <div class="absolute right-0 top-full z-50 mt-1 min-w-64 rounded-lg border border-line bg-raised shadow-panel">
                        <div class="border-b border-line px-3 py-2 text-xs font-medium text-muted">
                          Active jobs ({runningScripts.length})
                        </div>
                        {runningScripts.map((id) => {
                          const s = scripts.find((sc) => sc.id === id);
                          const j = jobs[id];
                          return (
                            <button
                              key={id}
                              class={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-hover ${id === selectedId ? "bg-hover" : ""}`}
                              onClick={() => { selectScript(id); setShowJobsPanel(false); }}
                            >
                              <span class={`h-2 w-2 shrink-0 rounded-full ${j?.running ? "bg-ok animate-pulse" : "bg-muted"}`} />
                              <span class="flex-1 truncate">{s?.name ?? id}</span>
                              {j?.structured.progress && (
                                <span class="text-xs text-muted">{Math.round(j.structured.progress.pct)}%</span>
                              )}
                              {id === selectedId && <span class="text-xs text-accent">current</span>}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}

              {readme && (
                <button
                  class={`btn ${showReadme ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setShowReadme((v) => !v)}
                  title={`${showReadme ? "Hide" : "Show"} ${readme.name} (⌘D)`}
                  aria-pressed={showReadme}
                >
                  <BookIcon />
                  Docs
                </button>
              )}

              <span class={`pill shrink-0 ${envPillClass}`} title={envLabel}>
                {envLabel}
              </span>

              {envStatus?.state === "missing" || envStatus?.state === "stale" ? (
                <button
                  class="btn btn-warn"
                  onClick={() => handlePrepareEnv()}
                  disabled={running || preparing}
                >
                  {preparing ? "Preparing…" : "Prepare Env"}
                </button>
              ) : null}

              {running ? (
                <button class="btn btn-danger" onClick={handleCancel} title="Stop the run (⌘.)">
                  <StopIcon />
                  Cancel
                </button>
              ) : (
                <>
                  {exitInfo && (
                    <button
                      class="btn btn-secondary"
                      onClick={handleRun}
                      disabled={!formValid || !envReady}
                      title="Run again with the same values (⌘↩)"
                    >
                      Run again
                    </button>
                  )}
                  {errorCount > 0 && (
                    <button
                      class="btn btn-secondary text-warn"
                      onClick={jumpToFirstError}
                      title={`${errorCount} field${errorCount === 1 ? "" : "s"} need attention — click to jump to the first one`}
                    >
                      {errorCount} {errorCount === 1 ? "error" : "errors"}
                    </button>
                  )}
                  <button
                    class="btn btn-secondary"
                    onClick={handleResetDefaults}
                    title="Reset all fields to schema defaults"
                    disabled={running}
                  >
                    Reset
                  </button>
                  <button
                    class="btn btn-secondary"
                    onClick={handlePreviewCommand}
                    disabled={!formValid || !envReady}
                    title="Preview the command line that will be executed"
                  >
                    Preview
                  </button>
                  <button
                    class="btn btn-run"
                    onClick={handleRun}
                    disabled={!formValid || !envReady}
                    title={
                      !envReady
                        ? "Prepare the environment first"
                        : !formValid
                          ? "Fix the highlighted fields first"
                          : "Run the script (⌘↩)"
                    }
                  >
                    <PlayIcon />
                    Run
                  </button>
                </>
              )}
            </header>

            {/* Command line preview (Plan.md §1.6) */}
            {showCmdPreview && cmdPreview && (
              <div class="flex shrink-0 items-start gap-3 border-b border-line bg-surface px-5 py-2">
                <span class="mt-px text-2xs font-semibold text-subtle">CMD</span>
                <code class="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-2xs leading-snug text-muted">
                  {cmdPreview}
                </code>
                <button
                  class="btn btn-secondary shrink-0"
                  onClick={() => setShowCmdPreview(false)}
                >
                  Close
                </button>
              </div>
            )}

            {/* Broken manifest banner (Plan.md §0 schema_error). The form below
                is a fallback; the error explains why it looks wrong. */}
            {schemaError && (
              <div class="flex shrink-0 items-start gap-3 border-b border-line bg-danger/[0.08] px-5 py-2">
                <span class="mt-px font-semibold text-danger">Manifest error</span>
                <pre class="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-2xs leading-snug text-danger">
{schemaError}
                </pre>
                <button
                  class="btn btn-secondary shrink-0"
                  onClick={() => selectedId && handleRelink(selectedId)}
                  title="Re-read the manifest from disk"
                >
                  Reload
                </button>
              </div>
            )}

            {/* Schema guessed banner (Plan.md §M7) — shows for pep723 and fallback */}
            {isGuessed && (
              <div class="flex shrink-0 items-center gap-3 border-b border-line bg-accent/[0.07] px-5 py-2">
                <span class="flex-1 text-[13px] text-muted">
                  {schema?.source === "pep723"
                    ? "Fields were guessed from PEP 723 metadata. Introspection reads the script's real arguments."
                    : "No manifest found — the form below is a bare fallback. Introspection reads the script's real arguments."}
                </span>
                <button
                  class="btn btn-primary"
                  onClick={() => setShowConsent(true)}
                  disabled={!envReady || introspecting}
                  title={envReady ? "Run introspection" : "Prepare the environment first"}
                >
                  {introspecting ? "Introspecting…" : "Introspect"}
                </button>
                <button class="btn btn-secondary" onClick={handleSaveManifest}>
                  Save Manifest
                </button>
              </div>
            )}

            {/* Env not ready banner */}
            {!envReady && envStatus && (
              <div
                class={`flex shrink-0 items-center gap-3 border-b border-line px-5 py-2 ${
                  envStatus.state === "failed" ? "bg-danger/[0.07]" : "bg-warn/[0.09]"
                }`}
              >
                <span class="flex-1 text-[13px] text-muted">
                  {envStatus.state === "missing" && "Environment not set up. Click Prepare Env to create an isolated venv."}
                  {envStatus.state === "stale" && `Environment is stale: ${envStatus.reason}. Rebuild required.`}
                  {envStatus.state === "failed" && `Environment failed: ${envStatus.message}`}
                  {envStatus.state === "building" && `Building environment… ${envStatus.pct.toFixed(0)}%`}
                </span>
                {(envStatus.state === "missing" || envStatus.state === "stale") && (
                  <button class="btn btn-warn" onClick={() => handlePrepareEnv()} disabled={running || preparing}>
                    {preparing ? "Preparing…" : "Prepare Env"}
                  </button>
                )}
              </div>
            )}

            {/* Env progress bar */}
            {envProgress && (
              <div class="shrink-0 border-b border-line bg-accent/[0.07] px-5 py-2">
                <div class="flex items-center gap-3 text-2xs text-muted">
                  <span class="shrink-0">{envProgress.message}</span>
                  <div class="h-1 flex-1 overflow-hidden rounded-full bg-fg/10">
                    <div
                      class="h-full rounded-full bg-accent transition-all duration-300"
                      style={{ width: `${envProgress.pct}%` }}
                    />
                  </div>
                  <span class="shrink-0 tabular-nums">{envProgress.pct.toFixed(0)}%</span>
                </div>
              </div>
            )}

            {/* Progress stays outside the tabs: while a run is in flight it is
                the only live signal, and hiding it defeats the point. */}
            <RunStatusBar running={running} structured={structured} exitInfo={exitInfo} />

            <Tabs tabs={panes} active={pane} onSelect={selectPane}>
              {pane === "output" && lines.length > 0 ? (
                <label class="flex cursor-pointer select-none items-center gap-1.5 text-2xs text-subtle">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.currentTarget.checked)}
                  />
                  Auto-scroll
                </label>
              ) : null}
            </Tabs>

            <div
              id={`panel-${pane}`}
              role="tabpanel"
              aria-labelledby={`tab-${pane}`}
              class="flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              {pane === "params" &&
                (schema.inputs.length > 0 ? (
                  <>
                    <div class="min-h-0 flex-1 overflow-y-auto">
                      <FormRenderer
                        inputs={schema.inputs}
                        values={values}
                        onChange={handleValueChange}
                        scriptId={schema.id}
                      />
                    </div>
                    {/* Presets (Plan.md §M6) — pinned, so they stay reachable
                        no matter how long the form is. */}
                    <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-line bg-surface px-5 py-2">
                      <span class="panel-title mr-1">Presets</span>
                      {scriptState?.presets.length === 0 && (
                        <span class="text-2xs text-subtle">None saved yet</span>
                      )}
                      {scriptState?.presets.map((p) => {
                        const isActive = activePreset === p.name;
                        return (
                          <button
                            key={p.name}
                            class={`btn py-1 ${isActive ? "btn-primary" : "btn-secondary"}`}
                            onClick={() => handleLoadPreset(p)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setPresetMenu({ x: e.clientX, y: e.clientY, preset: p });
                            }}
                            title={isActive ? (presetModified ? "Loaded — modified" : "Loaded") : "Load this preset"}
                          >
                            {p.name}
                            {isActive && presetModified && (
                              <span class="ml-1 h-1.5 w-1.5 rounded-full bg-warn" title="Modified" />
                            )}
                          </button>
                        );
                      })}
                      <div class="ml-auto flex items-center gap-1.5">
                        <input
                          type="text"
                          placeholder="New preset…"
                          value={presetName}
                          onInput={(e) => setPresetName(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && presetName.trim()) handleSavePreset();
                          }}
                          class="form-input w-36 py-1 text-xs"
                        />
                        <button
                          class="btn btn-primary py-1"
                          onClick={handleSavePreset}
                          disabled={!presetName.trim()}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div class="flex flex-1 items-center justify-center px-8 text-center">
                    <p class="text-[13px] text-muted">This script takes no parameters.</p>
                  </div>
                ))}

              {pane === "output" && (
                <LogView
                  lines={lines}
                  autoScroll={autoScroll}
                  logFilePath={currentJob?.logFilePath ?? undefined}
                />
              )}

              {pane === "results" && (
                <ResultView
                  jobId={currentJobId}
                  structured={structured}
                  artifacts={artifacts}
                  declaredResult={schema?.outputs.result ?? null}
                />
              )}

              {pane === "history" && (
                <div class="flex min-h-0 flex-1 flex-col">
                  {historyCount > 0 && (
                    <div class="flex shrink-0 items-center gap-2 border-b border-line px-5 py-2">
                      <div class="relative min-w-0 flex-1">
                        <SearchIcon size={13} class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-subtle" />
                        <input
                          type="text"
                          class="form-input w-full py-1 pl-7 pr-7 text-xs"
                          aria-label="Search history"
                          placeholder="Search runs…"
                          value={historySearch}
                          onInput={(e) => setHistorySearch(e.currentTarget.value)}
                          onKeyDown={(e) => { if (e.key === "Escape") setHistorySearch(""); }}
                        />
                        {historySearch && (
                          <button
                            class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-fg"
                            onClick={() => setHistorySearch("")}
                            title="Clear search"
                          >
                            <CloseIcon size={12} />
                          </button>
                        )}
                      </div>
                      {historySearch.trim() && filteredHistory.length !== historyCount && (
                        <span class="shrink-0 tabular-nums text-2xs text-subtle">
                          {filteredHistory.length} / {historyCount}
                        </span>
                      )}
                    </div>
                  )}
                  <div class="flex-1 overflow-y-auto px-5 py-3">
                    {historyCount === 0 ? (
                      <div class="flex h-full items-center justify-center text-center">
                        <p class="text-[13px] text-muted">No runs yet.</p>
                      </div>
                    ) : filteredHistory.length === 0 ? (
                      <div class="flex h-full items-center justify-center text-center">
                        <p class="text-[13px] text-muted">No runs match "{historySearch}".</p>
                      </div>
                    ) : (
                      <div class="flex flex-col">
                        {filteredHistory.map(({ entry, idx }) => (
                          <div
                            key={entry.job_id ?? `${entry.timestamp}-${idx}`}
                            class="row-hover group -mx-1.5 flex items-center gap-3 rounded px-1.5 py-1.5 text-2xs"
                          >
                            <span
                              class={`shrink-0 ${entry.exit_code === 0 ? "text-ok" : "text-danger"}`}
                              title={entry.exit_code === 0 ? "Succeeded" : "Failed"}
                              aria-label={entry.exit_code === 0 ? "Succeeded" : "Failed"}
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
                              exit {entry.exit_code ?? "—"}
                            </span>
                            <span class="tabular-nums text-subtle">
                              {(entry.duration_ms / 1000).toFixed(1)}s
                            </span>
                            <div class="ml-auto flex items-center gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                              {entry.job_id && (
                                <>
                                  <button
                                    class="text-subtle hover:text-fg disabled:opacity-30"
                                    onClick={() => handleOpenPastRun(entry.job_id!, "log")}
                                    title="Reveal this run's log in Finder"
                                  >
                                    Log
                                  </button>
                                  <button
                                    class="text-subtle hover:text-fg disabled:opacity-30"
                                    onClick={() => handleOpenPastRun(entry.job_id!, "files")}
                                    title="Open this run's output folder"
                                  >
                                    Files
                                  </button>
                                </>
                              )}
                              <button
                                class={`hover:underline disabled:opacity-30 ${
                                  compareBase === idx ? "text-accent font-medium" : "text-subtle hover:text-fg"
                                }`}
                                onClick={() => handleCompare(idx, entry)}
                                title={compareBase === null ? "Select for comparison" : compareBase === idx ? "Cancel comparison" : "Compare with this run"}
                              >
                                {compareBase === idx ? "Cancel" : "Compare"}
                              </button>
                              <button
                                class="text-accent hover:underline disabled:opacity-30"
                                onClick={() => handleRetry(entry)}
                                disabled={running}
                                title="Re-run with these values"
                              >
                                Retry
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

          </>
        ) : (
          <div
            data-tauri-drag-region
            class="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center"
          >
            {!loading && (
              <>
                <span class="text-3xl opacity-40">🐍</span>
                <p class="text-[13px] font-medium text-muted">No script selected</p>
                <p class="max-w-xs text-2xs leading-relaxed text-subtle">
                  Pick one from the sidebar, or import a new script to get started.
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {showReadme && readme && (
        <ReadmePanel
          doc={readme}
          onClose={() => setShowReadme(false)}
          onSelectLang={selectReadmeLang}
        />
      )}

      {/* Introspection consent dialog (Plan.md §M7) */}
      {showConsent && (
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={() => setShowConsent(false)}>
          <div class="w-full max-w-md rounded-xl border border-line bg-raised p-5 shadow-panel" onClick={(e) => e.stopPropagation()}>
            <h2 class="mb-1.5 text-[15px] font-semibold">Run Introspection?</h2>
            <p class="mb-4 text-[13px] leading-relaxed text-muted">
              PyShell will execute this script to detect its arguments.
              This runs all code at the module top-level — imports, function
              definitions, and any code outside <code>if __name__</code>.
              A 10-second timeout is enforced. No secrets are passed.
            </p>
            <div class="flex justify-between gap-2">
              <button
                class="btn btn-secondary px-3 py-1.5"
                onClick={handleShowCode}
              >
                Show Code
              </button>
              <div class="flex gap-2">
                <button
                  class="btn btn-secondary px-3 py-1.5"
                  onClick={() => setShowConsent(false)}
                >
                  Cancel
                </button>
                <button
                  class="btn btn-primary px-3 py-1.5"
                  onClick={handleIntrospect}
                >
                  Run Introspection
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Script code viewer */}
      {showGuide && <ScriptingGuide onClose={() => setShowGuide(false)} />}

      {showStore && (
        <StoreDialog
          scripts={scripts}
          runningScripts={runningScripts}
          onInstalled={handleStoreInstalled}
          onClose={() => setShowStore(false)}
        />
      )}

      {showCode && (
        <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] backdrop-blur-sm" onClick={() => setShowCode(false)}>
          <div class="mx-4 flex max-h-[80vh] w-full max-w-3xl flex-col rounded-xl border border-line bg-raised p-5 shadow-panel" onClick={(e) => e.stopPropagation()}>
            <div class="flex items-center justify-between mb-3">
              <h2 class="text-lg font-semibold">Script Code</h2>
              <button
                class="btn btn-ghost"
                onClick={() => setShowCode(false)}
              >
                <CloseIcon />
              </button>
            </div>
            <pre class="flex-1 overflow-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-relaxed">
              {scriptCode}
            </pre>
            <p class="mt-2 text-2xs text-subtle">
              This is the code that will be executed during introspection.
              Review it before proceeding.
            </p>
          </div>
        </div>
      )}

      {/* Dependency confirmation dialog (Plan.md §M2) */}
      {showDepsConfirm && (
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={() => setShowDepsConfirm(false)}>
          <div class="w-full max-w-lg rounded-xl border border-line bg-raised p-5 shadow-panel" onClick={(e) => e.stopPropagation()}>
            <h2 class="mb-1.5 text-[15px] font-semibold">Install Dependencies?</h2>
            <p class="mb-3 text-[13px] leading-relaxed text-muted">
              The following packages will be installed in an isolated virtual environment:
            </p>
            <div class="mb-4 max-h-48 overflow-y-auto rounded-lg border border-line bg-surface p-2">
              {depsList.map((dep) => (
                <div key={dep} class="text-sm font-mono">{dep}</div>
              ))}
            </div>
            <p class="mb-4 text-2xs text-subtle">
              Only pre-built wheels are used when available. Building from source (sdist) is supported as fallback for Python 3.13+.
            </p>
            <div class="flex justify-end gap-2">
              <button
                class="btn btn-secondary px-3 py-1.5"
                onClick={() => setShowDepsConfirm(false)}
              >
                Cancel
              </button>
              <button class="btn btn-run px-3 py-1.5" autoFocus onClick={() => doPrepareEnv()}>
                Install
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Onboarding dialog (Plan.md §M8) */}
      {showOnboarding && (
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={dismissOnboarding}>
          <div class="w-full max-w-md rounded-xl border border-line bg-raised p-5 shadow-panel" onClick={(e) => e.stopPropagation()}>
            <h2 class="mb-2 text-[15px] font-semibold">Welcome to PyShell</h2>
            <p class="mb-3 text-[13px] leading-relaxed text-muted">
              PyShell runs Python scripts in isolated virtual environments. To
              prepare environments and install dependencies, the app needs
              network access to download Python interpreters and packages via
              <code class="mx-0.5 rounded bg-fg/10 px-1 font-mono text-[12px]">uv</code>.
            </p>
            <p class="mb-3 text-[13px] leading-relaxed text-muted">
              Scripts run locally on your machine with full system access
              (no sandbox). Import only scripts you trust.
            </p>
            <p class="mb-4 text-[13px] leading-relaxed text-muted">
              Need something to run? The{" "}
              <span class="font-medium text-muted">+ Store</span> button in the sidebar
              installs ready-made scripts from the community repo.
            </p>
            <div class="flex justify-end gap-2">
              <button
                class="btn btn-secondary px-3 py-1.5"
                onClick={() => {
                  dismissOnboarding();
                  setShowStore(true);
                }}
              >
                Browse the Store
              </button>
              <button class="btn btn-primary px-3 py-1.5" autoFocus onClick={dismissOnboarding}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preset context menu (Plan.md §1.3) */}
      {presetMenu && (
        <ContextMenu
          x={presetMenu.x}
          y={presetMenu.y}
          items={[
            { label: "Load", onSelect: () => handleLoadPreset(presetMenu.preset) },
            { label: "Rename…", onSelect: () => { setRenameValue(presetMenu.preset.name); setRenaming(presetMenu.preset.name); } },
            { label: "Delete", separated: true, icon: <TrashIcon size={13} />, onSelect: () => handleDeletePreset(presetMenu.preset.name) },
          ]}
          onClose={() => setPresetMenu(null)}
        />
      )}

      {/* Rename preset dialog */}
      {renaming && (
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={() => setRenaming(null)}>
          <div class="w-full max-w-sm rounded-xl border border-line bg-raised p-5 shadow-panel" onClick={(e) => e.stopPropagation()}>
            <h2 class="mb-3 text-[15px] font-semibold">Rename preset</h2>
            <input
              type="text"
              class="form-input mb-4"
              value={renameValue}
              autoFocus
              onInput={(e) => setRenameValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRenamePreset(renaming, renameValue);
              }}
            />
            <div class="flex justify-end gap-2">
              <button class="btn btn-secondary" onClick={() => setRenaming(null)}>Cancel</button>
              <button
                class="btn btn-primary"
                onClick={() => handleRenamePreset(renaming, renameValue)}
                disabled={!renameValue.trim() || renameValue.trim() === renaming}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel confirmation (Plan.md §1.7) */}
      {showCancelConfirm && (
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setShowCancelConfirm(false)}>
          <div class="max-w-sm rounded-xl border border-line bg-raised p-5 shadow-panel" onClick={(e) => e.stopPropagation()}>
            <h2 class="mb-1.5 text-[15px] font-semibold">Cancel this run?</h2>
            <p class="mb-4 text-[13px] leading-relaxed text-muted">
              The script and all its child processes will be killed immediately. Any partial
              output is kept in the log.
            </p>
            <div class="flex justify-end gap-2">
              <button class="btn btn-secondary" autoFocus onClick={() => setShowCancelConfirm(false)}>
                Keep running
              </button>
              <button class="btn btn-danger" onClick={doCancel}>
                Cancel run
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Run comparison diff (Plan.md §2.2) */}
      {compareDiff && (
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={() => setCompareDiff(null)}>
          <div class="max-w-2xl w-full max-h-[80vh] overflow-y-auto rounded-xl border border-line bg-raised p-5 shadow-panel" onClick={(e) => e.stopPropagation()}>
            <div class="mb-4 flex items-center justify-between">
              <h2 class="text-[15px] font-semibold">Run comparison</h2>
              <button class="btn btn-secondary" onClick={() => setCompareDiff(null)}>Close</button>
            </div>
            <div class="mb-4 flex gap-6 text-2xs text-subtle">
              <div>
                <span class="font-medium text-muted">Base:</span>{" "}
                {new Date(compareDiff.base.timestamp).toLocaleString()} · exit {compareDiff.base.exit_code ?? "—"}
              </div>
              <div>
                <span class="font-medium text-muted">Target:</span>{" "}
                {new Date(compareDiff.target.timestamp).toLocaleString()} · exit {compareDiff.target.exit_code ?? "—"}
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
                  return <p class="text-[13px] text-muted">No differences — both runs used the same values.</p>;
                }
                return (
                  <>
                    <p class="mb-2 text-2xs text-subtle">{changedCount} field{changedCount === 1 ? "" : "s"} changed</p>
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
          </div>
        </div>
      )}
    </div>
  );
}
