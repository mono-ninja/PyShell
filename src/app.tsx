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
import { useSelectedScript } from "./hooks/useSelectedScript";
import type {
  ScriptSchema,
  EnvStatus,
  ScriptState,
  HistoryEntry,
  Preset,
  ScriptEntry,
  ScriptSource,
  EnvProgress,
} from "./types/schema";
import { ReadmePanel } from "./components/ReadmePanel";
import { Tabs } from "./components/Tabs";
import type { TabDef } from "./components/Tabs";
import { RunStatusBar } from "./components/RunStatusBar";
import { useArtifacts } from "./hooks/useArtifacts";
import { useFavorites } from "./hooks/useFavorites";
import { useMenuAction } from "./hooks/useMenuAction";
import { useStoreUpdates } from "./hooks/useStoreUpdates";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { missingNeeds } from "./lib/needs";
import { ScriptingGuide } from "./components/ScriptingGuide";
import { StoreDialog } from "./components/StoreDialog";
import { useEscape, hasOverlay } from "./lib/keyboard";
import { useI18n } from "./lib/i18n";
import { BookIcon, PlayIcon, StopIcon } from "./components/icons";
import { ScriptIcon } from "./lib/script-icon";
import { Settings } from "./components/Settings/Settings";
import { HistoryPanel } from "./components/HistoryPanel";
import { PresetsBar } from "./components/PresetsBar";
import {
  CancelConfirmDialog,
  CodeDialog,
  ConsentDialog,
  DepsConfirmDialog,
  OnboardingDialog,
} from "./components/dialogs";

const EMPTY_STRUCTURED: StructuredState = { progress: null, table: null, status: null, markdown: null, chart: null };

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

/** Defaults of every schema input that declares one (audit M15's merge base). */
function defaultsOf(schema: ScriptSchema): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const input of schema.inputs) {
    if (input.default !== undefined && input.default !== null) {
      defaults[input.key] = input.default;
    }
  }
  return defaults;
}

export function App() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const { notify, notifyError } = useToast();
  const { scripts, loading, refresh } = useScripts();
  const { favorites, toggleFavorite } = useFavorites(scripts, notifyError);
  const { jobs, run, cancel, clearJob, runningScripts } = useJobs();

  // The selected script and everything loaded for it (race-safe — see the hook).
  const {
    selectedId,
    selectedIdRef,
    schema,
    setSchema,
    envStatus,
    setEnvStatus,
    values,
    setValues,
    scriptState,
    setScriptState,
    readme,
    selectScript: loadScript,
    clearIfSelected,
    selectReadmeLang,
  } = useSelectedScript(notifyError);

  const [autoScroll, setAutoScroll] = useState(true);
  const [envProgress, setEnvProgress] = useState<EnvProgress | null>(null);
  const [showConsent, setShowConsent] = useState(false);
  const [introspecting, setIntrospecting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [showDepsConfirm, setShowDepsConfirm] = useState(false);
  const [depsList, setDepsList] = useState<string[]>([]);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [scriptCode, setScriptCode] = useState<ScriptSource | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [showStore, setShowStore] = useState(false);
  const [pane, setPane] = useState<PaneId>("params");
  // Content that landed while its tab was hidden, so the tab can say so.
  const [unseen, setUnseen] = useState<Set<PaneId>>(new Set());
  const [showReadme, setShowReadme] = useState(false);
  const [view, setView] = useState<View>("script");
  const [showCmdPreview, setShowCmdPreview] = useState(false);
  const [cmdPreview, setCmdPreview] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showJobsPanel, setShowJobsPanel] = useState(false);
  const [recentImports, setRecentImports] = useState<string[]>(loadRecentImports);
  // Dot on "+ Store": installed scripts with a newer version in the catalog.
  const storeUpdates = useStoreUpdates(scripts, showStore);
  const appUpdate = useAppUpdate();

  useEffect(() => {
    if (!localStorage.getItem(ONBOARDING_KEY)) {
      setShowOnboarding(true);
    }
  }, []);

  const dismissOnboarding = useCallback(() => {
    localStorage.setItem(ONBOARDING_KEY, "1");
    setShowOnboarding(false);
  }, []);

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
            notifyError(e, t("Manifest reload failed"));
          });
        // Re-check env status: a requirements.txt or pyshell.yaml edit may
        // have changed the env_key, flipping the pill from Ready to Stale.
        ipc<EnvStatus>("env_status", { scriptId: id })
          .then((status) => {
            if (selectedIdRef.current === id) setEnvStatus(status);
          })
          .catch((e) => {
            notifyError(e, t("Env status check failed"));
          });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh, notifyError, selectedIdRef, setSchema, setEnvStatus, t]);

  // Listen for env progress events (Plan.md §M2: env:{id}:progress). The
  // payload type is the ts-rs-generated binding — no hand-written interface.
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
  }, [selectedId, selectedIdRef]);

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
    setValues(defaultsOf(schema));
    setActivePreset(null);
  }, [schema, setValues]);

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
      notifyError(e, t("Command preview failed"));
    }
  }, [selectedId, values, notifyError, t]);

  // Selecting a script resets the pane-level UI, then the hook loads schema,
  // env, state and docs (with race protection — see useSelectedScript).
  const selectScript = useCallback((id: string) => {
    setView("script");
    setActivePreset(null);
    setShowReadme(false);
    setEnvProgress(null);
    setPane("params");
    setUnseen(new Set());
    loadScript(id);
  }, [loadScript]);

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
      notifyError(e, t("Import failed"));
    }
  }, [refresh, notifyError, t]);

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
      notifyError(e, t("Import failed"));
    }
  }, [refresh, notifyError, t]);

  const handleImportPath = useCallback(async (path: string) => {
    try {
      await ipc("import_script", { path });
      saveRecentImport(path);
      setRecentImports(loadRecentImports());
      await refresh();
    } catch (e) {
      notifyError(e, t("Import failed"));
    }
  }, [refresh, notifyError, t]);

  // A Store install already imported on the Rust side; this only stitches it
  // into the UI the way the local imports above do. The recent-imports menu
  // lists folders, so the entry .py's parent is what gets remembered.
  const handleStoreInstalled = useCallback((entry: ScriptEntry) => {
    const folder = entry.path.split(/[/\\]/).slice(0, -1).join("/");
    if (folder) saveRecentImport(folder);
    setRecentImports(loadRecentImports());
    refresh();
    selectScript(entry.id);
  }, [refresh, selectScript]);

  const handleRun = useCallback(async () => {
    if (!selectedId) return;
    try {
      await run(selectedId, values);
      await ipc("save_last_values", { scriptId: selectedId, values });
    } catch (e) {
      notifyError(e, t("Run failed"));
    }
  }, [selectedId, values, run, notifyError, t]);

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
      notifyError(e, t("Failed to list dependencies"));
      await doPrepareEnv(id);
    }
  }, [selectedId, preparing, t]);

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
      notifyError(e, t("Environment setup failed"));
    } finally {
      setPreparing(false);
      // Refresh either way: on failure the backend has recorded
      // EnvStatus::Failed, which is what the banner should show.
      try {
        const status = await ipc<EnvStatus>("env_status", { scriptId: id });
        if (selectedIdRef.current === id) setEnvStatus(status);
      } catch (e) {
        notifyError(e, t("Env status check failed"));
      }
    }
  }, [selectedId, preparing, notifyError, selectedIdRef, setEnvStatus, t]);

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
      notifyError(e, t("Refresh failed"));
    }
  }, [refresh, notifyError, selectedIdRef, setSchema, setEnvStatus, t]);

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
        notifyError(e, t("Relink reload failed"));
      }
    }
  }, [refresh, notifyError, selectedIdRef, setSchema, setEnvStatus, t]);

  const handleRemove = useCallback(async (id: string) => {
    // Cancel running job before removing (audit H11 — prevent orphaned process)
    await cancel(id);
    clearIfSelected(id);
    clearJob(id);
    await refresh();
  }, [refresh, clearJob, cancel, clearIfSelected]);

  /** Re-fetch the selected script's state (presets, history, last values). */
  const refreshScriptState = useCallback(async () => {
    const id = selectedIdRef.current;
    if (!id) return;
    try {
      setScriptState(await ipc<ScriptState>("get_state", { scriptId: id }));
    } catch (e) {
      notifyError(e, t("Could not load script state"));
    }
  }, [selectedIdRef, setScriptState, notifyError, t]);

  const handleLoadPreset = useCallback((preset: Preset) => {
    // Merge with schema defaults so new fields not in preset get their default (audit M15)
    const defaults = schema ? defaultsOf(schema) : {};
    setValues({ ...defaults, ...preset.values });
    setActivePreset(preset.name);
  }, [schema, setValues]);

  const handlePresetSaved = useCallback((name: string) => {
    setActivePreset(name);
    refreshScriptState();
  }, [refreshScriptState]);

  const handlePresetDeleted = useCallback((name: string) => {
    setActivePreset((cur) => (cur === name ? null : cur));
    refreshScriptState();
  }, [refreshScriptState]);

  const handlePresetRenamed = useCallback((oldName: string, newName: string) => {
    setActivePreset((cur) => (cur === oldName ? newName : cur));
    refreshScriptState();
  }, [refreshScriptState]);

  // The viewer reads the source in Rust (`script_source`), never from the
  // webview: scripts live outside the fs plugin's scope, so a frontend
  // readTextFile of the entry file fails for most scripts after a restart.
  const handleShowCode = useCallback(async () => {
    const id = selectedIdRef.current;
    if (!id || !schema) return;
    try {
      const source = await ipc<ScriptSource>("script_source", { scriptId: id });
      setScriptCode(source);
      setShowCode(true);
    } catch (e) {
      notifyError(e, t("Could not read script"));
      setScriptCode(null);
      setShowCode(false);
    }
  }, [schema, notifyError, selectedIdRef, t]);

  const handleDuplicate = useCallback(async (scriptId: string) => {
    try {
      await ipc("duplicate_script", { scriptId });
      await refresh();
      notify("info", t("Script duplicated"));
    } catch (e) {
      notifyError(e, t("Duplicate failed"));
    }
  }, [refresh, notify, notifyError, t]);

  const handleExportPresets = useCallback(async (scriptId: string) => {
    try {
      const state = await ipc<ScriptState>("get_state", { scriptId });
      if (state.presets.length === 0) {
        notify("info", t("This script has no presets to export"));
        return;
      }
      const dest = await save({
        defaultPath: `${scriptId}-presets.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (dest) {
        await writeTextFile(dest, JSON.stringify({ presets: state.presets }, null, 2));
        notify("info", t("Exported {n} presets", { n: state.presets.length }));
      }
    } catch (e) {
      notifyError(e, t("Export failed"));
    }
  }, [notify, notifyError, t]);

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
          notify("info", t("Invalid presets file"));
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
        notify("info", t("Imported {n} presets", { n: data.presets.length }));
      }
    } catch (e) {
      notifyError(e, t("Import failed"));
    }
  }, [selectedId, scriptState, notify, notifyError, setScriptState, t]);

  const handleIntrospect = useCallback(async () => {
    if (!selectedId) return;
    setShowConsent(false);
    setIntrospecting(true);
    try {
      const newSchema = await ipc<ScriptSchema>("introspect_script", { scriptId: selectedId });
      setSchema(newSchema);
      setValues(defaultsOf(newSchema));
    } catch (e) {
      notifyError(e, t("Introspection failed"));
    } finally {
      setIntrospecting(false);
    }
  }, [selectedId, notifyError, setSchema, setValues, t]);

  const handleSaveManifest = useCallback(async () => {
    if (!selectedId) return;
    try {
      await ipc("save_generated_manifest", { scriptId: selectedId });
    } catch (e) {
      notifyError(e, t("Save manifest failed"));
    }
  }, [selectedId, notifyError, t]);

  // Retry re-runs with the historic values — and records them as the last
  // values, so switching away and back keeps what was just run (plan P2-2).
  const handleRetry = useCallback(async (entry: HistoryEntry) => {
    const id = selectedIdRef.current;
    if (!id) return;
    setValues(entry.values);
    try {
      await run(id, entry.values);
      await ipc("save_last_values", { scriptId: id, values: entry.values });
    } catch (e) {
      notifyError(e, t("Run failed"));
    }
  }, [run, setValues, notifyError, selectedIdRef, t]);

  // Open a past run's log file or its output directory in Finder (Plan.md §1.2).
  const handleOpenPastRun = useCallback(async (jobId: string, kind: "log" | "files") => {
    const id = selectedIdRef.current;
    if (!id) return;
    try {
      const dir = await ipc<string>("job_run_dir", { scriptId: id, jobId });
      if (kind === "log") {
        await revealItemInDir(`${dir}/output.log`);
      } else {
        await openPath(dir);
      }
    } catch (e) {
      notifyError(e, t("Could not open past run"));
    }
  }, [notifyError, selectedIdRef, t]);

  const handleValueChange = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, [setValues]);

  const envLabel = (() => {
    if (envProgress) return `${envProgress.message} (${envProgress.pct.toFixed(0)}%)`;
    if (!envStatus) return "";
    switch (envStatus.state) {
      case "ready":
        return t("✓ Ready ({size} MB)", { size: (envStatus.size_bytes / 1_048_576).toFixed(1) });
      case "missing":
        return t("⚠ Needs setup");
      case "stale":
        return t("⚠ Stale — needs rebuild");
      case "building":
        return t("Building… {pct}%", { pct: envStatus.pct.toFixed(0) });
      case "failed":
        return t("✗ {message}", { message: envStatus.message });
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

  const panes: TabDef<PaneId>[] = [
    { id: "params", label: t("Parameters"), badge: schema?.inputs.length || null },
    { id: "output", label: t("Output"), badge: lines.length || null },
    { id: "results", label: t("Results"), badge: schema?.outputs.result && schema.outputs.result !== "none" ? schema.outputs.result : null, dot: unseen.has("results") },
    { id: "history", label: t("History"), badge: historyCount || null },
  ];

  // Keyboard shortcuts come from the native menu (src-tauri/src/menu.rs), not
  // from a `window` listener: on macOS a key equivalent claimed by the menu
  // never reaches the webview, so a second binding here would be dead code —
  // and a double-fire on the platforms where it isn't.
  //
  // Any modal on screen owns the keyboard: ⌘↩ behind the Store or the Guide
  // would start a run the user cannot see. `hasOverlay()` asks the keyboard
  // stack — every dialog registers there through <Modal>, including the ones
  // whose open/closed state lives inside a child component (rename, compare,
  // store confirm), and the full-screen Store and Guide overlays.
  useMenuAction((action) => {
    if (hasOverlay()) return;
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
      // The result belongs in Settings — a toast cannot carry a Download
      // button, and "up to date" is worth saying out loud when asked.
      case "update:check":
        setView("settings");
        appUpdate
          .check(true)
          .then((r) =>
            notify(
              "info",
              r ? t("PyShell {version} is available", { version: r.version }) : t("PyShell is up to date"),
            ),
          )
          .catch((e) => notifyError(e, t("Update check failed")));
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
          selectScript(action.slice(4));
        }
    }
  });

  // The dialogs' Escape handling lives in <Modal>; these two are not modals —
  // the preview strip and the jobs dropdown sit alongside the app, so global
  // keys keep working behind them.
  useEscape(showCmdPreview, () => setShowCmdPreview(false), false);
  useEscape(showJobsPanel, () => setShowJobsPanel(false), false);

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
        updateAvailable={appUpdate.release !== null}
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
            update={appUpdate}
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
                      <span class="shrink-0 text-2xs text-subtle" title={t("Script version")}>v{schema.version}</span>
                    )}
                  </div>
                  {schema.description && !showReadme && (
                    <p class="truncate text-2xs text-subtle">{schema.description}</p>
                  )}
                </div>
                {schema.runtime.timeout && (
                  <span
                    class="pill shrink-0 bg-warn/12 text-warn"
                    title={t("This script will be killed after {n}s unless it exits first", { n: schema.runtime.timeout })}
                  >
                    ⏱ {schema.runtime.timeout}s
                  </span>
                )}
                {isGuessed && (
                  <span class="pill shrink-0 bg-accent/12 text-accent" title={schema?.source === "pep723" ? t("Schema inferred from PEP 723 metadata") : t("No manifest found — schema is a bare fallback")}>
                    {schema?.source === "pep723" ? "PEP 723" : t("Guessed")}
                  </span>
                )}
                {/* Only *missing* dependencies get a pill — a satisfied one is
                    business as usual, and needs-free scripts (the majority)
                    must not grow a new element in the header. */}
                {missing.length > 0 && (
                  <span
                    class="pill shrink-0 bg-warn/12 text-warn"
                    title={t("This script expects other scripts to be installed: {list}. Install them from the Store (+ Store) — installed ones are passed to it as PYSHELL_DEPS.", { list: missing.join(", ") })}
                  >
                    {missing.length === 1
                      ? t("Needs: {id}", { id: missing[0] })
                      : t("Needs: {n} scripts", { n: missing.length })}
                  </span>
                )}
              </div>

              {otherRunningCount > 0 && (
                <div class="relative shrink-0">
                  <button
                    class="pill shrink-0 bg-ok/12 text-ok hover:bg-ok/20 cursor-pointer"
                    title={t("{n} other scripts running", { n: otherRunningCount })}
                    onClick={() => setShowJobsPanel((v) => !v)}
                  >
                    {t("{n} running", { n: otherRunningCount })} ▾
                  </button>
                  {showJobsPanel && (
                    <>
                      <div class="fixed inset-0 z-40" onClick={() => setShowJobsPanel(false)} />
                      <div class="absolute right-0 top-full z-50 mt-1 min-w-64 rounded-lg border border-line bg-raised shadow-panel">
                        <div class="border-b border-line px-3 py-2 text-xs font-medium text-muted">
                          {t("Active jobs ({count})", { count: runningScripts.length })}
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
                              {id === selectedId && <span class="text-xs text-accent">{t("current")}</span>}
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
                  title={`${showReadme ? t("Hide") : t("Show")} ${readme.name} (⌘D)`}
                  aria-pressed={showReadme}
                >
                  <BookIcon />
                  {t("Docs")}
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
                  {preparing ? t("Preparing…") : t("Prepare Env")}
                </button>
              ) : null}

              {running ? (
                <button class="btn btn-danger" onClick={handleCancel} title={t("Stop the run (⌘.)")}>
                  <StopIcon />
                  {t("Cancel")}
                </button>
              ) : (
                <>
                  {exitInfo && (
                    <button
                      class="btn btn-secondary"
                      onClick={handleRun}
                      disabled={!formValid || !envReady}
                      title={t("Run again with the same values (⌘↩)")}
                    >
                      {t("Run again")}
                    </button>
                  )}
                  {errorCount > 0 && (
                    <button
                      class="btn btn-secondary text-warn"
                      onClick={jumpToFirstError}
                      title={t("{n} fields need attention", { n: errorCount })}
                    >
                      {t("{n} errors", { n: errorCount })}
                    </button>
                  )}
                  <button
                    class="btn btn-secondary"
                    onClick={handleResetDefaults}
                    title={t("Reset all fields to schema defaults")}
                    disabled={running}
                  >
                    {t("Reset")}
                  </button>
                  <button
                    class="btn btn-secondary"
                    onClick={handlePreviewCommand}
                    disabled={!formValid || !envReady}
                    title={t("Preview the command line that will be executed")}
                  >
                    {t("Preview")}
                  </button>
                  <button
                    class="btn btn-run"
                    onClick={handleRun}
                    disabled={!formValid || !envReady}
                    title={
                      !envReady
                        ? t("Prepare the environment first")
                        : !formValid
                          ? t("Fix the highlighted fields first")
                          : t("Run the script (⌘↩)")
                    }
                  >
                    <PlayIcon />
                    {t("Run")}
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
                  {t("Close")}
                </button>
              </div>
            )}

            {/* Broken manifest banner (Plan.md §0 schema_error). The form below
                is a fallback; the error explains why it looks wrong. */}
            {schemaError && (
              <div class="flex shrink-0 items-start gap-3 border-b border-line bg-danger/[0.08] px-5 py-2">
                <span class="mt-px font-semibold text-danger">{t("Manifest error")}</span>
                <pre class="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-2xs leading-snug text-danger">
{schemaError}
                </pre>
                <button
                  class="btn btn-secondary shrink-0"
                  onClick={() => selectedId && handleRelink(selectedId)}
                  title={t("Re-read the manifest from disk")}
                >
                  {t("Reload")}
                </button>
              </div>
            )}

            {/* Schema guessed banner (Plan.md §M7) — shows for pep723 and fallback */}
            {isGuessed && (
              <div class="flex shrink-0 items-center gap-3 border-b border-line bg-accent/[0.07] px-5 py-2">
                <span class="flex-1 text-[13px] text-muted">
                  {schema?.source === "pep723"
                    ? t("Fields were guessed from PEP 723 metadata. Introspection reads the script's real arguments.")
                    : t("No manifest found — the form below is a bare fallback. Introspection reads the script's real arguments.")}
                </span>
                <button
                  class="btn btn-primary"
                  onClick={() => setShowConsent(true)}
                  disabled={!envReady || introspecting}
                  title={envReady ? t("Run introspection") : t("Prepare the environment first")}
                >
                  {introspecting ? t("Introspecting…") : t("Introspect")}
                </button>
                <button class="btn btn-secondary" onClick={handleSaveManifest}>
                  {t("Save Manifest")}
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
                  {envStatus.state === "missing" && t("Environment not set up. Click Prepare Env to create an isolated venv.")}
                  {envStatus.state === "stale" && t("Environment is stale: {reason}. Rebuild required.", { reason: envStatus.reason })}
                  {envStatus.state === "failed" && t("Environment failed: {message}", { message: envStatus.message })}
                  {envStatus.state === "building" && t("Building environment… {pct}%", { pct: envStatus.pct.toFixed(0) })}
                </span>
                {(envStatus.state === "missing" || envStatus.state === "stale") && (
                  <button class="btn btn-warn" onClick={() => handlePrepareEnv()} disabled={running || preparing}>
                    {preparing ? t("Preparing…") : t("Prepare Env")}
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
                  {t("Auto-scroll")}
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
                    <PresetsBar
                      scriptId={schema.id}
                      values={values}
                      presets={scriptState?.presets ?? []}
                      activePreset={activePreset}
                      presetModified={presetModified}
                      onLoadPreset={handleLoadPreset}
                      onSaved={handlePresetSaved}
                      onDeleted={handlePresetDeleted}
                      onRenamed={handlePresetRenamed}
                      refreshState={refreshScriptState}
                    />
                  </>
                ) : (
                  <div class="flex flex-1 items-center justify-center px-8 text-center">
                    <p class="text-[13px] text-muted">{t("This script takes no parameters.")}</p>
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

              {pane === "history" && selectedId && (
                <HistoryPanel
                  scriptId={selectedId}
                  history={scriptState?.history ?? []}
                  running={running}
                  onRetry={handleRetry}
                  onOpenPastRun={handleOpenPastRun}
                />
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
                <p class="text-[13px] font-medium text-muted">{t("No script selected")}</p>
                <p class="max-w-xs text-2xs leading-relaxed text-subtle">
                  {t("Pick one from the sidebar, or import a new script to get started.")}
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
        <ConsentDialog
          onShowCode={handleShowCode}
          onClose={() => setShowConsent(false)}
          onConfirm={handleIntrospect}
        />
      )}

      {/* Script code viewer */}
      {showGuide && <ScriptingGuide onClose={() => setShowGuide(false)} />}

      {showStore && (
        <StoreDialog
          scripts={scripts}
          runningScripts={runningScripts}
          onInstalled={handleStoreInstalled}
          onRemoved={handleRemove}
          onClose={() => setShowStore(false)}
        />
      )}

      {showCode && scriptCode && (
        <CodeDialog source={scriptCode} onClose={() => setShowCode(false)} />
      )}

      {/* Dependency confirmation dialog (Plan.md §M2) */}
      {showDepsConfirm && (
        <DepsConfirmDialog
          deps={depsList}
          onClose={() => setShowDepsConfirm(false)}
          onInstall={() => doPrepareEnv()}
        />
      )}

      {/* Onboarding dialog (Plan.md §M8) */}
      {showOnboarding && (
        <OnboardingDialog
          onDismiss={dismissOnboarding}
          onBrowseStore={() => {
            dismissOnboarding();
            setShowStore(true);
          }}
        />
      )}

      {/* Cancel confirmation (Plan.md §1.7) */}
      {showCancelConfirm && (
        <CancelConfirmDialog
          onKeepRunning={() => setShowCancelConfirm(false)}
          onCancelRun={doCancel}
        />
      )}
    </div>
  );
}
