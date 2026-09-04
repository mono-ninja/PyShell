use std::path::PathBuf;

use tauri::State;

use crate::error::{AppError, Result};
use crate::manifest;
use crate::store;
use crate::AppState;

/// Import a Python script by path. Accepts either a .py file or a directory
/// containing pyshell.yaml. Tries pyshell.yaml, PEP 723, then introspection.
#[tauri::command]
pub async fn import_script(path: PathBuf, state: State<'_, AppState>) -> Result<manifest::model::ScriptEntry> {
    if !path.exists() {
        return Err(AppError::ScriptNotFound(path.to_string_lossy().to_string()));
    }

    let path = path.canonicalize().unwrap_or(path);

    // If a directory was selected, find the entry point inside it
    let (entry_path, dir) = if path.is_dir() {
        // Look for pyshell.yaml in the directory
        let yaml_manifest = path.join("pyshell.yaml");
        if yaml_manifest.exists() {
            match manifest::yaml::parse_yaml_manifest(&yaml_manifest) {
                Ok(schema) => (schema.runtime.entry.clone(), path.clone()),
                Err(_) => {
                    // Broken yaml: fall back to a single .py file if there is
                    // one, so the import still lands and the parse error is
                    // surfaced via resolve_schema's schema_error rather than
                    // aborting the whole import.
                    let py: Vec<_> = std::fs::read_dir(&path)
                        .map_err(|e| AppError::Other(e.to_string()))?
                        .flatten()
                        .filter(|e| e.path().extension().is_some_and(|ext| ext == "py"))
                        .collect();
                    match py.len() {
                        1 => (py[0].path(), path.clone()),
                        _ => {
                            return Err(AppError::Other(
                                "pyshell.yaml is invalid and the folder has no single .py file to fall back to".to_string(),
                            ));
                        }
                    }
                }
            }
        } else {
            // No manifest — look for .py files
            let py_files: Vec<_> = std::fs::read_dir(&path)
                .map_err(|e| AppError::Other(e.to_string()))?
                .flatten()
                .filter(|e| e.path().extension().is_some_and(|ext| ext == "py"))
                .collect();

            match py_files.len() {
                0 => {
                    return Err(AppError::Other(
                        "no .py files found in selected folder".to_string(),
                    ));
                }
                1 => (py_files[0].path(), path.clone()),
                _ => {
                    // Multiple .py files: try PEP 723 in each, use first match
                    for f in &py_files {
                        if let Some(schema) = manifest::pep723::parse_pep723(&f.path())? {
                            return finish_import(schema, None, f.path(), &path, &state);
                        }
                    }
                    let names: Vec<String> = py_files
                        .iter()
                        .filter_map(|f| f.path().file_name().map(|n| n.to_string_lossy().to_string()))
                        .collect();
                    return Err(AppError::Other(format!(
                        "folder has multiple .py files without pyshell.yaml — select a specific .py file instead\nFiles: {}",
                        names.join(", ")
                    )));
                }
            }
        }
    } else {
        // A .py file was selected
        let dir = path.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
        (path.clone(), dir)
    };

    // Try pyshell.yaml in the same directory as the entry point
    let (schema, schema_error) = resolve_schema(&entry_path);
    finish_import(schema, schema_error, entry_path, &dir, &state)
}

/// Resolve a script's schema using the pyshell.yaml → PEP 723 → fallback
/// priority (Plan.md §3.3: previously duplicated in import and reload).
///
/// On a manifest parse/validation error the schema is a fallback (so the UI
/// still has something to render) and the error string is returned alongside
/// so the caller can record it on the [`ScriptEntry`] (Plan.md §0 schema_error).
fn resolve_schema(
    entry_path: &std::path::Path,
) -> (manifest::model::ScriptSchema, Option<String>) {
    let dir = entry_path.parent().unwrap_or(std::path::Path::new("."));
    let yaml_manifest = dir.join("pyshell.yaml");

    if yaml_manifest.exists() {
        return match manifest::yaml::parse_yaml_manifest(&yaml_manifest) {
            Ok(s) => (s, None),
            Err(e) => (manifest::introspect::fallback_schema(entry_path), Some(e.to_string())),
        };
    }

    if let Ok(Some(pep723_schema)) = manifest::pep723::parse_pep723(entry_path) {
        return (pep723_schema, None);
    }

    (manifest::introspect::fallback_schema(entry_path), None)
}

/// If a `pyshell.yaml` sits next to `entry_path` and fails to parse/validate,
/// return the error message. Returns `None` when there is no yaml or it parses.
///
/// Cheaper than [`resolve_schema`] when only the error state is needed (e.g. at
/// startup, for every imported script).
fn yaml_parse_error(entry_path: &std::path::Path) -> Option<String> {
    let dir = entry_path.parent().unwrap_or(std::path::Path::new("."));
    let yaml_manifest = dir.join("pyshell.yaml");
    if !yaml_manifest.exists() {
        return None;
    }
    match manifest::yaml::parse_yaml_manifest(&yaml_manifest) {
        Ok(_) => None,
        Err(e) => Some(e.to_string()),
    }
}

fn finish_import(
    schema: manifest::model::ScriptSchema,
    schema_error: Option<String>,
    entry_path: PathBuf,
    dir: &std::path::Path,
    state: &State<'_, AppState>,
) -> Result<manifest::model::ScriptEntry> {
    let _ = dir; // dir is used for yaml lookup in the caller

    let entry = manifest::model::ScriptEntry {
        id: schema.id.clone(),
        name: schema.name.clone(),
        icon: schema.icon.clone(),
        category: schema.category.clone(),
        needs: schema.needs.clone(),
        path: entry_path.clone(),
        source: schema.source.clone(),
        reachable: true,
        schema_error,
    };

    save_schema(state, &schema)?;

    {
        let mut scripts = state.scripts.lock().unwrap();
        scripts.retain(|s| s.id != entry.id);
        scripts.push(entry.clone());
        store::state::save_script_list(&state.app_support_dir, &scripts)?;
    }

    let bookmark_store = store::bookmarks::BookmarkStore::new(&state.app_support_dir);
    let _ = bookmark_store.save_bookmark(&entry.id, &entry_path);

    // Register the new script's paths with the file watcher (Plan.md §3.4:
    // previously only startup paths were watched, so imported scripts were
    // not monitored until restart).
    {
        let paths = watch_paths_for(&entry, state);
        if let Some(tx) = state.watcher_tx.lock().unwrap().as_ref() {
            let _ = tx.send(crate::manifest::watcher::WatchCommand::Add(paths));
        }
    }

    tracing::info!("Imported script: {} ({})", entry.name, entry.id);

    Ok(entry)
}

/// List all imported scripts.
#[tauri::command]
pub async fn list_scripts(state: State<'_, AppState>) -> Result<Vec<manifest::model::ScriptEntry>> {
    let mut scripts = state.scripts.lock().unwrap().clone();

    // Check reachability
    for s in &mut scripts {
        s.reachable = s.path.exists();
    }

    Ok(scripts)
}

/// Get the full schema for a script.
#[tauri::command]
pub async fn get_schema(script_id: String, state: State<'_, AppState>) -> Result<manifest::model::ScriptSchema> {
    load_schema(&state, &script_id)?
        .ok_or_else(|| AppError::ScriptNotFound(format!("schema for {}", script_id)))
}

/// Reload the schema from disk (e.g. after editing pyshell.yaml).
///
/// A broken manifest no longer fails the whole reload: the last-good schema is
/// kept (so the form stays usable) and the error is recorded on the entry's
/// `schema_error` for the UI to show (Plan.md §0). On a successful parse the
/// error is cleared and the new schema is saved.
///
/// Resolution logic is shared with `import_script` via `resolve_schema`
/// (Plan.md §3.3 — previously duplicated here).
#[tauri::command]
pub async fn reload_schema(
    script_id: String,
    state: State<'_, AppState>,
) -> Result<manifest::model::ScriptSchema> {
    let entry = {
        let scripts = state.scripts.lock().unwrap().clone();
        scripts
            .into_iter()
            .find(|s| s.id == script_id)
            .ok_or_else(|| AppError::ScriptNotFound(script_id.clone()))?
    };

    if !entry.path.exists() {
        return Err(AppError::ScriptNotFound(format!("file moved or deleted: {}", entry.path.display())));
    }

    // Load the old schema to diff the requirements path for the watcher. If
    // pyshell.yaml now points at a different requirements file, the old path
    // must be unwatched and the new one added — otherwise the new file's
    // changes go unnoticed until restart.
    let old_requirements = load_schema(&state, &script_id)?
        .and_then(|s| s.runtime.requirements);

    let (mut schema, schema_error) = resolve_schema(&entry.path);

    if let Some(err) = &schema_error {
        set_schema_error(&state, &script_id, err)?;
        // Keep the last-good schema if we have one; otherwise use the fallback
        // (and persist it so a later get_schema still resolves).
        if let Some(saved) = load_schema(&state, &script_id)? {
            return Ok(saved);
        }
        // Fix up the fallback so it doesn't orphan the saved schema file
        // (keyed by id) or rename the script in the sidebar.
        schema.id = entry.id.clone();
        schema.name = entry.name.clone();
        schema.icon = entry.icon.clone();
        schema.category = entry.category.clone();
        save_schema(&state, &schema)?;
        return Ok(schema);
    }

    clear_schema_error(&state, &script_id)?;
    save_schema(&state, &schema)?;

    // Sync display fields (name, icon, category, needs) from the reloaded
    // schema into the script list entry. The sidebar reads from ScriptEntry,
    // not ScriptSchema, so without this an edit to `name:` in pyshell.yaml
    // never surfaces until the script is re-imported. (finish_import does the
    // same copy at import time.)
    {
        let mut scripts = state.scripts.lock().unwrap();
        if let Some(entry) = scripts.iter_mut().find(|s| s.id == script_id) {
            let changed = entry.name != schema.name
                || entry.icon != schema.icon
                || entry.category != schema.category
                || entry.needs != schema.needs;
            if changed {
                entry.name = schema.name.clone();
                entry.icon = schema.icon.clone();
                entry.category = schema.category.clone();
                entry.needs = schema.needs.clone();
                let list = scripts.clone();
                drop(scripts);
                store::state::save_script_list(&state.app_support_dir, &list)?;
            }
        }
    }

    // If the requirements path changed, update the watcher so the new file is
    // monitored and the old one is released.
    let new_requirements = schema.runtime.requirements.clone();
    if old_requirements != new_requirements {
        let mut remove = Vec::new();
        let mut add = Vec::new();
        if let Some(old) = &old_requirements {
            if old.exists() {
                remove.push(old.clone());
            }
        }
        if let Some(new) = &new_requirements {
            if new.exists() {
                add.push(new.clone());
            }
        }
        if let Some(tx) = state.watcher_tx.lock().unwrap().as_ref() {
            if !remove.is_empty() {
                let _ = tx.send(crate::manifest::watcher::WatchCommand::Remove(remove));
            }
            if !add.is_empty() {
                let _ = tx.send(crate::manifest::watcher::WatchCommand::Add(add));
            }
        }
    }

    Ok(schema)
}

/// Record a manifest error on a script's entry, persisting the script list.
fn set_schema_error(state: &State<'_, AppState>, script_id: &str, error: &str) -> Result<()> {
    let mut scripts = state.scripts.lock().unwrap();
    if let Some(entry) = scripts.iter_mut().find(|s| s.id == script_id) {
        entry.schema_error = Some(error.to_string());
        let list = scripts.clone();
        drop(scripts);
        store::state::save_script_list(&state.app_support_dir, &list)?;
    }
    Ok(())
}

/// Clear a manifest error on a script's entry, persisting only if it changed.
fn clear_schema_error(state: &State<'_, AppState>, script_id: &str) -> Result<()> {
    let mut scripts = state.scripts.lock().unwrap();
    let changed = if let Some(entry) = scripts.iter_mut().find(|s| s.id == script_id) {
        if entry.schema_error.is_some() {
            entry.schema_error = None;
            true
        } else {
            false
        }
    } else {
        false
    };
    if changed {
        let list = scripts.clone();
        drop(scripts);
        store::state::save_script_list(&state.app_support_dir, &list)?;
    }
    Ok(())
}

/// Re-validate every imported script's manifest and refresh its `schema_error`.
///
/// Called once at startup so a manifest that broke while the app was closed is
/// visible immediately, not only after the watcher happens to fire.
pub fn validate_schema_errors(state: &AppState) {
    let entries = state.scripts.lock().unwrap().clone();
    let mut updated = entries;
    let mut changed = false;
    for entry in updated.iter_mut() {
        if !entry.path.exists() {
            continue;
        }
        let err = yaml_parse_error(&entry.path);
        if entry.schema_error != err {
            entry.schema_error = err;
            changed = true;
        }
    }
    if changed {
        if store::state::save_script_list(&state.app_support_dir, &updated).is_ok() {
            *state.scripts.lock().unwrap() = updated;
        }
    }
}

/// Duplicate a script: re-import the same path with a new ID and copy presets
/// (Plan.md §2.6). History is not copied — the duplicate starts fresh.
#[tauri::command]
pub async fn duplicate_script(
    script_id: String,
    state: State<'_, AppState>,
) -> Result<manifest::model::ScriptEntry> {
    let entry = {
        let scripts = state.scripts.lock().unwrap().clone();
        scripts
            .into_iter()
            .find(|s| s.id == script_id)
            .ok_or_else(|| AppError::ScriptNotFound(script_id.clone()))?
    };

    if !entry.path.exists() {
        return Err(AppError::ScriptNotFound(format!("file moved or deleted: {}", entry.path.display())));
    }

    // Resolve the schema (same logic as import_script, via resolve_schema)
    let (mut schema, schema_error) = resolve_schema(&entry.path);

    // Generate a new unique ID and name. Include a short UUID suffix so two
    // duplications within the same second can't collide.
    let new_id = format!("{}-copy-{}-{}", schema.id, chrono::Local::now().format("%Y%m%d%H%M%S"), &uuid::Uuid::new_v4().to_string()[..6]);
    schema.id = new_id.clone();
    schema.name = format!("{} (copy)", schema.name);

    let new_entry = manifest::model::ScriptEntry {
        id: new_id.clone(),
        name: schema.name.clone(),
        icon: schema.icon.clone(),
        category: schema.category.clone(),
        needs: schema.needs.clone(),
        path: entry.path.clone(),
        source: schema.source.clone(),
        reachable: true,
        schema_error,
    };

    save_schema(&state, &schema)?;

    // Save bookmark so security-scoped access survives restart on macOS
    let bookmark_store = store::bookmarks::BookmarkStore::new(&state.app_support_dir);
    let _ = bookmark_store.save_bookmark(&new_id, &entry.path);

    {
        let mut scripts = state.scripts.lock().unwrap();
        scripts.push(new_entry.clone());
        store::state::save_script_list(&state.app_support_dir, &scripts)?;
    }

    // Copy presets from the original script's state (no history)
    let orig_state = store::state::load_script_state(&state.state_dir(), &script_id);
    if !orig_state.presets.is_empty() {
        // Strip secret sentinels from copied presets: the keychain entry is
        // under the original script's ID, so the duplicate's presets would
        // reference secrets that don't exist for the new ID. The user can
        // re-set secrets on the duplicate.
        let cleaned_presets = orig_state
            .presets
            .into_iter()
            .map(|mut p| {
                p.values.retain(|_, v| v.as_str() != Some("__secret_set__"));
                p
            })
            .collect();
        let new_state = manifest::model::ScriptState {
            last_values: std::collections::HashMap::new(),
            presets: cleaned_presets,
            history: vec![],
        };
        store::state::save_script_state(&state.state_dir(), &new_id, &new_state)?;
    }

    // Register with watcher
    {
        let paths = watch_paths_for(&new_entry, &state);
        if let Some(tx) = state.watcher_tx.lock().unwrap().as_ref() {
            let _ = tx.send(crate::manifest::watcher::WatchCommand::Add(paths));
        }
    }

    tracing::info!("Duplicated script: {} → {} ({})", script_id, new_entry.name, new_id);
    Ok(new_entry)
}

/// Relink a script to a new path (when the file has moved).
#[tauri::command]
pub async fn relink_script(
    script_id: String,
    new_path: PathBuf,
    state: State<'_, AppState>,
) -> Result<manifest::model::ScriptEntry> {
    let new_path = new_path.canonicalize().unwrap_or(new_path);
    if !new_path.exists() {
        return Err(AppError::ScriptNotFound(new_path.to_string_lossy().to_string()));
    }

    let mut scripts = state.scripts.lock().unwrap();
    let entry = scripts
        .iter_mut()
        .find(|s| s.id == script_id)
        .ok_or_else(|| AppError::ScriptNotFound(script_id.clone()))?;

    entry.path = new_path.clone();
    entry.reachable = true;

    let updated = entry.clone();
    store::state::save_script_list(&state.app_support_dir, &scripts)?;

    // Update bookmark
    let bookmark_store = store::bookmarks::BookmarkStore::new(&state.app_support_dir);
    let _ = bookmark_store.save_bookmark(&script_id, &new_path);

    Ok(updated)
}

/// Remove a script from the list, optionally deleting its venv.
#[tauri::command]
pub async fn remove_script(
    script_id: String,
    delete_env: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    // Cancel any running job for this script *before* removing it from the
    // list. Otherwise the job keeps running with no entry in the script list,
    // and reset_env fails because the env is in use — leaving the system
    // inconsistent (script gone from list, job still alive, files leaked).
    let cancelled = state.jobs.cancel_for_script(&script_id);
    if cancelled > 0 {
        tracing::info!("Cancelled {} running job(s) for script '{}' during removal", cancelled, script_id);
    }

    // Collect paths to unwatch before removing from the list
    let paths_to_unwatch: Vec<PathBuf> = {
        let scripts = state.scripts.lock().unwrap();
        let entry = scripts.iter().find(|s| s.id == script_id);
        match entry {
            Some(e) => watch_paths_for(e, &state),
            None => Vec::new(),
        }
    };

    let mut scripts = state.scripts.lock().unwrap();
    scripts.retain(|s| s.id != script_id);
    store::state::save_script_list(&state.app_support_dir, &scripts)?;
    drop(scripts);

    // Unregister from the file watcher (Plan.md §3.4)
    if !paths_to_unwatch.is_empty() {
        if let Some(tx) = state.watcher_tx.lock().unwrap().as_ref() {
            let _ = tx.send(crate::manifest::watcher::WatchCommand::Remove(paths_to_unwatch));
        }
    }

    // Best-effort env deletion: a failure here (e.g. venv locked by a
    // lingering process) must not prevent the rest of the cleanup or
    // propagate an error to the frontend.
    if delete_env {
        if let Err(e) = crate::env::manager::reset_env(&state, &script_id) {
            tracing::warn!("Failed to delete env for '{}': {}", script_id, e);
        }
    }

    // Remove saved schema (Plan.md §3.4: previously leaked)
    let schema_file = state.app_support_dir.join("schemas").join(format!("{}.json", script_id));
    let _ = std::fs::remove_file(&schema_file);

    // Remove bookmark files — both the `.bookmark` data and the `.path` string
    // (Plan.md §3.4: previously only `.path` was removed, leaking `.bookmark`).
    let bookmark_store = store::bookmarks::BookmarkStore::new(&state.app_support_dir);
    let _ = std::fs::remove_file(bookmark_store.bookmarks_dir.join(format!("{}.bookmark", script_id)));
    let _ = std::fs::remove_file(bookmark_store.bookmarks_dir.join(format!("{}.path", script_id)));

    // Remove per-script state (presets, history, last_values)
    let state_file = state.state_dir().join(format!("{}.json", script_id));
    let _ = std::fs::remove_file(&state_file);

    // Remove output directory (run logs, artifacts) — best effort, may be large
    let output_dir = state.output_dir().join(&script_id);
    let _ = std::fs::remove_dir_all(&output_dir);

    // Unpin it, or every ⌘-number after it would shift when the stale id was
    // finally dropped on the next read.
    store::favorites::forget(&state.app_support_dir, &script_id);
    let remaining = store::favorites::load(
        &state.app_support_dir,
        &state.scripts.lock().unwrap().iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
    );
    crate::commands::favorites::sync_menu(&app, &state, &remaining);

    Ok(())
}

/// Run introspection on a script to guess its argument schema.
/// This is arbitrary code execution — the frontend must gate behind consent UI
/// (Plan.md §M7). Requires a prepared venv.
#[tauri::command]
pub async fn introspect_script(
    script_id: String,
    state: State<'_, AppState>,
) -> Result<manifest::model::ScriptSchema> {
    let schema = load_schema(&state, &script_id)?
        .ok_or_else(|| AppError::ScriptNotFound(script_id.clone()))?;

    let scripts = state.scripts.lock().unwrap().clone();
    let entry = scripts
        .iter()
        .find(|s| s.id == script_id)
        .ok_or_else(|| AppError::ScriptNotFound(script_id.clone()))?;

    if !entry.path.exists() {
        return Err(AppError::ScriptNotFound(format!(
            "file moved or deleted: {}",
            entry.path.display()
        )));
    }

    let venv_python = crate::env::manager::get_python_for_script(&state, &schema)?;

    tracing::info!("Introspecting script {} (consent given)", script_id);
    let new_schema = manifest::introspect::introspect_script(&entry.path, &venv_python).await?;

    save_schema(&state, &new_schema)?;

    Ok(new_schema)
}

/// Save a generated introspection schema as pyshell.yaml next to the script.
#[tauri::command]
pub async fn save_generated_manifest(
    script_id: String,
    state: State<'_, AppState>,
) -> Result<PathBuf> {
    let schema = load_schema(&state, &script_id)?
        .ok_or_else(|| AppError::ScriptNotFound(script_id.clone()))?;

    let scripts = state.scripts.lock().unwrap().clone();
    let entry = scripts
        .iter()
        .find(|s| s.id == script_id)
        .ok_or_else(|| AppError::ScriptNotFound(script_id.clone()))?;

    let dir = entry.path.parent().unwrap_or(std::path::Path::new("."));
    let manifest_path = dir.join("pyshell.yaml");

    // Strip the `source` field before serializing — it's a runtime-only tag
    // (set by the backend, ignored by the YAML parser), not a user-facing
    // manifest field. Writing `source: guessed` into pyshell.yaml is noise.
    let mut yaml = serde_yaml::to_string(&schema)
        .map_err(|e| AppError::Manifest(format!("failed to serialize manifest: {}", e)))?;
    yaml = yaml.lines()
        .filter(|line| !line.starts_with("source:"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";

    // Atomic write: tmp → fsync → rename (consistent with save_schema)
    let tmp = manifest_path.with_extension("yaml.tmp");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(yaml.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &manifest_path)?;

    Ok(manifest_path)
}

// --- Helpers ---

/// Maximum README size we will hand to the frontend. A doc this big is not a
/// doc any more, and the whole thing crosses the IPC boundary as one string.
const README_MAX_BYTES: u64 = 512 * 1024;

/// Read the document that sits next to a script, if there is one: a page written
/// for whoever runs the script (`<script-name>.md` or `pyshell.md`), falling back
/// to the project's `README` (see [`find_doc`]).
///
/// Discovered on demand rather than stored in the schema: the file can appear,
/// change or be deleted without PyShell re-importing anything, so the directory
/// is the only source of truth. Returns `None` when there is nothing to show.
///
/// The command keeps its `script_readme` name: it is the frontend's entry point
/// and renaming it would be churn across the IPC surface for no behaviour change.
#[tauri::command]
pub async fn script_readme(
    script_id: String,
    lang: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<manifest::model::ScriptDoc>> {
    let entry_path = {
        let scripts = state.scripts.lock().unwrap();
        scripts
            .iter()
            .find(|s| s.id == script_id)
            .map(|s| s.path.clone())
            .ok_or_else(|| AppError::ScriptNotFound(script_id.clone()))?
    };

    let variants = find_docs(&entry_path);
    if variants.is_empty() {
        return Ok(None);
    }

    // An unknown or absent `lang` falls back to the first variant rather than
    // erroring: the panel asks for whatever it showed last, and that language
    // may be gone since the file was renamed or deleted.
    let (lang, path) = variants
        .iter()
        .find(|(l, _)| *l == lang)
        .unwrap_or(&variants[0])
        .clone();

    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size > README_MAX_BYTES {
        return Err(AppError::Other(format!(
            "{} is {} KB — too large to display (limit {} KB)",
            path.file_name().unwrap_or_default().to_string_lossy(),
            size / 1024,
            README_MAX_BYTES / 1024
        )));
    }

    // Lossy on purpose: a README with a stray non-UTF-8 byte should still be
    // readable rather than failing the whole panel.
    let bytes = std::fs::read(&path)?;
    let content = String::from_utf8_lossy(&bytes).into_owned();

    Ok(Some(manifest::model::ScriptDoc {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: path.clone(),
        content,
        lang,
        variants: variants
            .iter()
            .map(|(l, p)| manifest::model::DocVariant {
                lang: l.clone(),
                name: p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
            })
            .collect(),
    }))
}

/// Look for the document to show in the Docs panel, case-insensitively.
///
/// The most specific document wins:
///
/// 1. `<script-name>.md` — `report-demo.md` beside `report-demo.py`. Several
///    single-file scripts can share one directory, and only a name tied to the
///    script can tell their documents apart.
/// 2. `pyshell.md` — the folder's document, for a project whose directory *is*
///    the script. Sits next to `pyshell.yaml`, so its purpose is legible from a
///    directory listing.
/// 3. `README.*` — the fallback, so a project that only has one still gets a
///    panel; `.md` beats `.txt` so the richer file wins.
///
/// A `README` is written for whoever clones the repo — install steps, licence,
/// contributing — while this panel is read by whoever is about to *run* the
/// script and needs to know what the fields mean. The first two ranks give an
/// author somewhere to write that without either audience getting the other's
/// document.
///
/// Directory order is arbitrary, so candidates are scored rather than
/// taken first-found.
/// Is `code` plausibly a language suffix rather than part of the base name?
///
/// This is what keeps `my_script.md` (documenting `my_script.py`) from being
/// read as base `my` + language `script`. Real codes are short — `ua`, `en`,
/// `pt-br` — so anything longer than a subtag is treated as part of the name.
/// Checked only after the full base name has failed to match, so a script
/// genuinely called `my_en.py` still resolves its own `my_en.md` first.
fn is_lang_code(code: &str) -> bool {
    fn subtag(s: &str, min: usize, max: usize) -> bool {
        let n = s.chars().count();
        n >= min && n <= max && s.chars().all(|c| c.is_ascii_alphanumeric())
    }
    match code.split_once('-') {
        Some((primary, region)) => subtag(primary, 2, 3) && subtag(region, 2, 4),
        None => subtag(code, 2, 3) && code.chars().all(|c| c.is_ascii_alphabetic()),
    }
}

/// Split a filename stem into its base and optional language suffix, given the
/// base it is being matched against. Returns `None` when it is neither the bare
/// base nor `base_<lang>`.
fn lang_of(stem: &str, base: &str) -> Option<Option<String>> {
    if stem == base {
        return Some(None);
    }
    let rest = stem.strip_prefix(base)?.strip_prefix('_')?;
    is_lang_code(rest).then(|| Some(rest.to_string()))
}

/// Rank of a document filename, plus the language it is written in.
/// Lower rank wins; `None` means the file is not a document at all.
fn doc_rank(name: &str, script_stem: &str) -> Option<(u8, Option<String>)> {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s, e),
        // Extensionless `README` is the last-resort rank and has no variants.
        None => return (name == "readme").then_some((4, None)),
    };
    let markdown = ext == "md" || ext == "markdown";

    // An empty stem would make every `.md` in the directory rank first.
    if markdown && !script_stem.is_empty() {
        if let Some(lang) = lang_of(stem, script_stem) {
            return Some((0, lang));
        }
    }
    if markdown {
        if let Some(lang) = lang_of(stem, "pyshell") {
            return Some((1, lang));
        }
        if let Some(lang) = lang_of(stem, "readme") {
            return Some((2, lang));
        }
    }
    if ext == "txt" {
        if let Some(lang) = lang_of(stem, "readme") {
            return Some((3, lang));
        }
    }
    None
}

/// Every language variant of the best-ranked document in one directory.
fn docs_in_dir(dir: &std::path::Path, script_stem: &str) -> Vec<(Option<String>, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut best_rank = u8::MAX;
    let mut found: Vec<(u8, Option<String>, PathBuf)> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if let Some((rank, lang)) = doc_rank(&name, script_stem) {
            best_rank = best_rank.min(rank);
            found.push((rank, lang, path));
        }
    }

    // Only the winning rank's translations are offered: mixing `pyshell_ua.md`
    // with `README.md` in one picker would silently switch document, not
    // language.
    let mut variants: Vec<(Option<String>, PathBuf)> = found
        .into_iter()
        .filter(|(rank, _, _)| *rank == best_rank)
        .map(|(_, lang, path)| (lang, path))
        .collect();

    // Default first, then by code — directory order is arbitrary, and the panel
    // opens on the first entry.
    variants.sort_by(|a, b| match (&a.0, &b.0) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Less,
        (Some(_), None) => std::cmp::Ordering::Greater,
        (Some(x), Some(y)) => x.cmp(y),
    });
    variants
}

/// Resolve a script's document, newest convention first.
///
/// A `docs/` subdirectory beside the script wins outright: it is where a
/// project is expected to keep its pages, and finding one there means the
/// author opted in. Only when it holds no document at all does this fall back
/// to the script's own directory, which is the older layout and still valid.
fn find_docs(entry_path: &std::path::Path) -> Vec<(Option<String>, PathBuf)> {
    let Some(dir) = entry_path.parent() else {
        return Vec::new();
    };
    let stem = entry_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let in_docs = docs_in_dir(&dir.join("docs"), &stem);
    if !in_docs.is_empty() {
        return in_docs;
    }
    docs_in_dir(dir, &stem)
}

/// The single best document, ignoring translations. Kept for the tests that
/// pin the ranking, and for any caller that just needs "is there a page?".
#[cfg(test)]
fn find_doc(entry_path: &std::path::Path) -> Option<PathBuf> {
    find_docs(entry_path).into_iter().next().map(|(_, p)| p)
}

fn save_schema(state: &State<'_, AppState>, schema: &manifest::model::ScriptSchema) -> Result<()> {
    let schemas_dir = state.app_support_dir.join("schemas");
    std::fs::create_dir_all(&schemas_dir)?;
    let file = schemas_dir.join(format!("{}.json", schema.id));
    let content = serde_json::to_string_pretty(schema)?;

    // Atomic write: tmp → fsync → rename (Plan.md §3.4: previously wrote
    // directly, risking a truncated schema on crash/power loss).
    let tmp = file.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        use std::io::Write;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &file)?;
    Ok(())
}

/// All filesystem paths to watch for a script: the entry `.py`, its
/// `pyshell.yaml` (if present), and its `requirements` file (if declared).
///
/// The requirements path is resolved to absolute at manifest parse time and
/// stored on the saved schema, so we load it from disk rather than the
/// [`ScriptEntry`] (which carries no schema fields). Watching it lets the env
/// pill flip to "Stale" the moment dependencies change, without re-selecting
/// the script — the env_key hash detects the change, the watcher just needs
/// to trigger the re-check.
pub(crate) fn watch_paths_for(
    entry: &manifest::model::ScriptEntry,
    state: &AppState,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if entry.path.exists() {
        paths.push(entry.path.clone());
    }
    let dir = entry.path.parent().unwrap_or(std::path::Path::new("."));
    let yaml = dir.join("pyshell.yaml");
    if yaml.exists() {
        paths.push(yaml);
    }
    if let Ok(Some(schema)) = load_schema(state, &entry.id) {
        if let Some(req) = &schema.runtime.requirements {
            if req.exists() {
                paths.push(req.clone());
            }
        }
    }
    paths
}

/// Read a script's saved schema (`schemas/{id}.json`). `pub(crate)` because
/// `commands::repo` reads the installed version from it when enriching the
/// store catalog.
pub(crate) fn load_schema(
    state: &AppState,
    script_id: &str,
) -> Result<Option<manifest::model::ScriptSchema>> {
    let file = state.app_support_dir.join("schemas").join(format!("{}.json", script_id));
    if !file.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&file)?;
    let schema: manifest::model::ScriptSchema = serde_json::from_str(&content)?;
    Ok(Some(schema))
}

/// The folder a script lives in — its "project folder".
///
/// For a single-file import this is the file's parent; for a folder import the
/// entry point is inside the folder, so the parent is the folder itself.
fn folder_of(state: &AppState, script_id: &str) -> Result<PathBuf> {
    let entry = {
        let scripts = state.scripts.lock().unwrap();
        scripts
            .iter()
            .find(|s| s.id == script_id)
            .map(|s| s.path.clone())
            .ok_or_else(|| AppError::ScriptNotFound(script_id.to_string()))?
    };

    let dir = entry
        .parent()
        .ok_or_else(|| AppError::Other(format!("{} has no parent folder", entry.display())))?
        .to_path_buf();

    if !dir.exists() {
        return Err(AppError::Other(format!(
            "folder no longer exists: {}",
            dir.display()
        )));
    }
    Ok(dir)
}

/// Path of the script's folder, for "Copy path".
#[tauri::command]
pub async fn script_folder(script_id: String, state: State<'_, AppState>) -> Result<String> {
    Ok(folder_of(&state, &script_id)?.to_string_lossy().to_string())
}

/// Run a launcher over the script's folder.
///
/// Arguments are passed as argv, never through a shell, so a folder name with
/// spaces or shell metacharacters cannot turn into a command. The path itself is
/// resolved from the script list rather than accepted from the frontend.
fn spawn_with(program: &str, args: &[&str], dir: &std::path::Path) -> std::io::Result<bool> {
    let status = std::process::Command::new(program)
        .args(args)
        .arg(dir)
        .status()?;
    Ok(status.success())
}

/// Open the script's folder in PyCharm.
///
/// Tries the known macOS bundle names via LaunchServices (which finds them
/// wherever they are installed, including JetBrains Toolbox locations), then
/// falls back to the `charm` command-line launcher.
#[tauri::command]
pub async fn open_in_pycharm(script_id: String, state: State<'_, AppState>) -> Result<()> {
    let dir = folder_of(&state, &script_id)?;

    #[cfg(target_os = "macos")]
    {
        const BUNDLES: &[&str] = &[
            "PyCharm",
            "PyCharm CE",
            "PyCharm Community Edition",
            "PyCharm Professional Edition",
        ];
        for bundle in BUNDLES {
            if spawn_with("open", &["-a", bundle], &dir).unwrap_or(false) {
                tracing::info!("Opened {} in {}", dir.display(), bundle);
                return Ok(());
            }
        }
    }

    // JetBrains' shell launcher, on any platform where it is on PATH.
    for launcher in ["charm", "pycharm", "pycharm64.exe"] {
        if spawn_with(launcher, &[], &dir).unwrap_or(false) {
            tracing::info!("Opened {} via {}", dir.display(), launcher);
            return Ok(());
        }
    }

    Err(AppError::Other(
        "PyCharm not found. Install it, or enable its command-line launcher \
         (Tools → Create Command-line Launcher)."
            .to_string(),
    ))
}

/// Open the script's folder in the system terminal.
#[tauri::command]
pub async fn open_in_terminal(script_id: String, state: State<'_, AppState>) -> Result<()> {
    let dir = folder_of(&state, &script_id)?;

    #[cfg(target_os = "macos")]
    {
        if spawn_with("open", &["-a", "Terminal"], &dir).unwrap_or(false) {
            return Ok(());
        }
    }

    #[cfg(windows)]
    {
        // Windows Terminal first; `-d` takes the starting directory as argv, so
        // no shell quoting is involved.
        if spawn_with("wt.exe", &["-d"], &dir).unwrap_or(false) {
            return Ok(());
        }
        // Fall back to a plain console started in that directory.
        let started = std::process::Command::new("cmd")
            .arg("/C")
            .arg("start")
            .arg("") // window title placeholder, required by `start`
            .arg("cmd")
            .arg("/K")
            .arg("cd")
            .arg("/D")
            .arg(&dir)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if started {
            return Ok(());
        }
    }

    Err(AppError::Other(format!(
        "could not open a terminal at {}",
        dir.display()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::model::SchemaSource;

    fn state_with(script_path: PathBuf) -> AppState {
        let state = AppState::new(std::env::temp_dir().join("pyshell-folder-test"));
        state.scripts.lock().unwrap().push(manifest::model::ScriptEntry {
            id: "s1".into(),
            name: "s1".into(),
            icon: None,
            category: None,
            needs: Vec::new(),
            path: script_path,
            source: SchemaSource::Yaml,
            reachable: true,
            schema_error: None,
        });
        state
    }

    /// Write the given filenames into a fresh directory and return it.
    fn dir_with(names: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pyshell-doc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for n in names {
            std::fs::write(dir.join(n), b"# doc").unwrap();
        }
        dir
    }

    /// Resolve the doc for `script` inside `dir`, by filename.
    fn found_for(dir: &std::path::Path, script: &str) -> Option<String> {
        find_doc(&dir.join(script)).map(|p| p.file_name().unwrap().to_string_lossy().to_string())
    }

    /// Language codes offered for `script` in `dir`, in the order the picker
    /// would show them (`None` renders as the default entry).
    fn langs_for(dir: &std::path::Path, script: &str) -> Vec<Option<String>> {
        find_docs(&dir.join(script)).into_iter().map(|(l, _)| l).collect()
    }

    /// Create `dir/docs/` holding `names`, plus the files in `root`.
    fn dir_with_docs(root: &[&str], docs: &[&str]) -> PathBuf {
        let dir = dir_with(root);
        let sub = dir.join("docs");
        std::fs::create_dir_all(&sub).unwrap();
        for n in docs {
            std::fs::write(sub.join(n), b"# doc").unwrap();
        }
        dir
    }

    #[test]
    fn docs_subfolder_wins_over_the_script_directory() {
        let dir = dir_with_docs(&["main.py", "pyshell.md"], &["pyshell.md"]);
        let found = find_doc(&dir.join("main.py")).unwrap();
        assert_eq!(found.parent().unwrap().file_name().unwrap(), "docs");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_docs_folder_falls_back_to_the_script_directory() {
        // A `docs/` holding no document at all must not hide the older layout.
        let dir = dir_with_docs(&["main.py", "pyshell.md"], &["notes.txt"]);
        let found = find_doc(&dir.join("main.py")).unwrap();
        assert_eq!(found.parent().unwrap(), dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn language_variants_are_collected_with_the_default_first() {
        let dir = dir_with(&["main.py", "pyshell_ua.md", "pyshell.md", "pyshell_de.md"]);
        assert_eq!(
            langs_for(&dir, "main.py"),
            vec![None, Some("de".into()), Some("ua".into())],
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_underscored_script_name_is_not_read_as_a_language() {
        // The trap: splitting on `_` would make `my_script.md` base `my`
        // language `script`, and the script would lose its own document.
        let dir = dir_with(&["my_script.py", "my_script.md"]);
        assert_eq!(found_for(&dir, "my_script.py").as_deref(), Some("my_script.md"));
        assert_eq!(langs_for(&dir, "my_script.py"), vec![None]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_underscored_script_still_gets_translations() {
        let dir = dir_with(&["my_script.py", "my_script.md", "my_script_ua.md"]);
        assert_eq!(
            langs_for(&dir, "my_script.py"),
            vec![None, Some("ua".into())],
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn variants_never_mix_two_different_documents() {
        // `pyshell.md` outranks `README.md`; offering the README as a
        // "language" would switch document rather than language.
        let dir = dir_with(&["main.py", "pyshell.md", "pyshell_ua.md", "README.md"]);
        assert_eq!(langs_for(&dir, "main.py"), vec![None, Some("ua".into())]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_translation_alone_is_still_found() {
        let dir = dir_with(&["main.py", "pyshell_ua.md"]);
        assert_eq!(found_for(&dir, "main.py").as_deref(), Some("pyshell_ua.md"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn region_subtags_are_accepted() {
        let dir = dir_with(&["main.py", "pyshell.md", "pyshell_pt-br.md"]);
        assert_eq!(langs_for(&dir, "main.py"), vec![None, Some("pt-br".into())]);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn found(dir: &std::path::Path) -> Option<String> {
        found_for(dir, "main.py")
    }

    /// Every shipped example must resolve to *its own* document. The scripts in
    /// `examples/` share one directory, so a broken ranking would silently show
    /// one script's page for all of them.
    #[test]
    fn every_shipped_example_resolves_its_own_doc() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("examples");
        if !root.exists() {
            eprintln!("Skipping test: {} not found", root.display());
            return;
        }
        for (script, expected) in [
            ("hello/main.py", "hello/pyshell.md"),
            ("link-checker/main.py", "link-checker/pyshell.md"),
            ("ip-domains/main.py", "ip-domains/pyshell.md"),
            // ninjascan also ships a README.md; the operator page must win.
            ("ninjascan/scan.py", "ninjascan/pyshell.md"),
            ("needs-demo/main.py", "needs-demo/pyshell.md"),
            ("single-file.py", "single-file.md"),
            ("no-manifest.py", "no-manifest.md"),
            ("misbehaving.py", "misbehaving.md"),
            ("progress-demo.py", "progress-demo.md"),
            ("report-demo.py", "report-demo.md"),
        ] {
            let doc = find_doc(&root.join(script))
                .unwrap_or_else(|| panic!("{script} has no Docs page"));
            assert_eq!(
                doc.strip_prefix(&root).unwrap(),
                std::path::Path::new(expected),
                "{script} resolved to the wrong document",
            );
        }
    }

    #[test]
    fn doc_prefers_pyshell_md_over_the_project_readme() {
        // The whole point of the ranking: a repo can keep a technical README for
        // GitHub and a pyshell.md written for whoever runs the script.
        let dir = dir_with(&["README.md", "pyshell.md"]);
        assert_eq!(found(&dir).as_deref(), Some("pyshell.md"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn doc_named_after_the_script_wins_over_the_folder_document() {
        let dir = dir_with(&["README.md", "pyshell.md", "report-demo.md"]);
        assert_eq!(found_for(&dir, "report-demo.py").as_deref(), Some("report-demo.md"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn each_script_in_a_shared_folder_gets_its_own_doc() {
        // examples/ holds several single-file scripts side by side: without a
        // script-named document they would all show the same page.
        let dir = dir_with(&["report-demo.md", "progress-demo.md", "report-demo.py", "progress-demo.py"]);
        assert_eq!(found_for(&dir, "report-demo.py").as_deref(), Some("report-demo.md"));
        assert_eq!(found_for(&dir, "progress-demo.py").as_deref(), Some("progress-demo.md"));
        // A third script in the same folder falls through to the shared fallback.
        assert_eq!(found_for(&dir, "other.py"), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_script_named_doc_belonging_to_a_sibling_is_not_borrowed() {
        let dir = dir_with(&["report-demo.md"]);
        assert_eq!(found_for(&dir, "misbehaving.py"), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn doc_falls_back_to_readme_when_there_is_no_pyshell_md() {
        let dir = dir_with(&["README.md"]);
        assert_eq!(found(&dir).as_deref(), Some("README.md"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn doc_prefers_markdown_over_plain_text() {
        let dir = dir_with(&["README.txt", "README.md"]);
        assert_eq!(found(&dir).as_deref(), Some("README.md"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn doc_matches_case_insensitively() {
        let dir = dir_with(&["PyShell.MD"]);
        assert_eq!(found(&dir).as_deref(), Some("PyShell.MD"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn doc_ignores_the_manifest_and_unrelated_files() {
        // pyshell.yaml sits in the same folder and must never be shown as prose.
        let dir = dir_with(&["pyshell.yaml", "main.py", "notes.md"]);
        assert_eq!(found(&dir), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn doc_is_none_for_an_empty_or_missing_directory() {
        let dir = dir_with(&[]);
        assert_eq!(found(&dir), None);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(found(&dir), None, "a deleted folder must not panic");
    }

    #[test]
    fn folder_of_returns_the_parent_directory() {
        let dir = std::env::temp_dir().join(format!("pyshell-fo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("main.py");
        std::fs::write(&script, b"print()").unwrap();

        let state = state_with(script);
        let got = folder_of(&state, "s1").expect("should resolve");
        // canonicalize: /var vs /private/var on macOS
        assert_eq!(got.canonicalize().unwrap(), dir.canonicalize().unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_of_rejects_an_unknown_script() {
        let state = state_with(PathBuf::from("/tmp/whatever/main.py"));
        assert!(folder_of(&state, "nope").is_err());
    }

    #[test]
    fn folder_of_reports_a_folder_that_no_longer_exists() {
        // A relinkable script whose folder was deleted must produce a clear
        // error rather than handing a dead path to `open`.
        let missing = std::env::temp_dir()
            .join(format!("pyshell-gone-{}", uuid::Uuid::new_v4()))
            .join("main.py");
        let state = state_with(missing);

        let err = folder_of(&state, "s1").unwrap_err().to_string();
        assert!(err.contains("no longer exists"), "{}", err);
    }
}
