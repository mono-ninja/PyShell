use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use crate::error::{AppError, Result};
use crate::manifest::model::{RepoInstallResult, RepoScript, ScriptEntry};
use crate::repo;
use crate::AppState;

/// The cached catalog for this session — fetching a fresh one if this is the
/// first call *or the cache has expired* ([`repo::CATALOG_TTL`], 5 minutes).
///
/// Without the TTL, a push to the repo stayed invisible until a manual Refresh
/// or an app restart: opening the dialog or launching the app now re-checks on
/// its own. `force_refresh` (the Refresh button) ignores the age entirely.
///
/// A fetch costs 2 of the 60 unauthenticated GitHub API requests per hour.
///
/// Entries are enriched with `installed_version` *per call*: which scripts are
/// installed (and at what version) changes during the session, while the cached
/// catalog deliberately stays pure.
#[tauri::command]
pub async fn repo_catalog(
    force_refresh: bool,
    state: State<'_, AppState>,
) -> Result<Vec<RepoScript>> {
    let catalog = fresh_catalog(&state, force_refresh).await?;
    Ok(enrich(catalog.entries.clone(), &state))
}

/// Fill `installed_version` on every entry that matches an imported script's
/// id, from that script's saved schema.
fn enrich(mut entries: Vec<RepoScript>, state: &AppState) -> Vec<RepoScript> {
    let scripts = state.scripts.lock().unwrap().clone();
    for entry in &mut entries {
        let Some(installed) = scripts.iter().find(|s| s.id == entry.id) else {
            continue;
        };
        if let Ok(Some(schema)) =
            crate::commands::scripts::load_schema(state, &installed.id)
        {
            entry.installed_version = schema.version;
        }
    }
    entries
}

/// Download one script folder from the community repo into
/// `destination/{dir}` and import it through the same path as "+ Folder" —
/// plus every script it transitively `needs` that is not installed yet, so a
/// pipeline's last stage arrives with its whole chain.
///
/// The requested script lands even when a dependency later in the chain fails
/// (root-first order); already-installed dependencies are skipped — updating
/// them is what the explicit Update button is for. Each folder installs and
/// imports exactly like a solo one (staging, atomic move, bookmarks, watcher).
#[tauri::command]
pub async fn repo_install(
    dir: String,
    destination: PathBuf,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RepoInstallResult> {
    let catalog = fresh_catalog(&state, false).await?;

    let installed: HashSet<String> = {
        let scripts = state.scripts.lock().unwrap();
        scripts.iter().map(|s| s.id.clone()).collect()
    };
    let dirs = repo::install_closure(&dir, &catalog, &installed)?;

    let mut result: Option<ScriptEntry> = None;
    let mut extras: Vec<ScriptEntry> = Vec::new();
    for d in &dirs {
        let folder = repo::install(d, &destination, &catalog, Some(&app)).await?;
        // `State` is a shared handle — each import in the chain takes a clone.
        let imported = crate::commands::scripts::import_script(folder, state.clone()).await?;
        if d == &dir {
            result = Some(imported);
        } else {
            tracing::info!("store: installed dependency '{}' alongside '{}'", imported.name, dir);
            extras.push(imported);
        }
    }

    Ok(RepoInstallResult {
        entry: result.ok_or_else(|| AppError::Other("install finished without the requested script".into()))?,
        extras,
    })
}

/// Update an already-installed store script to the repo's current version.
///
/// The folder to replace is resolved **in Rust** from the installed script's
/// entry — the frontend never sends a path (the same rule as Copy path / Open
/// in PyCharm), and an update lands wherever the script actually lives, even
/// if it was imported from a different destination or its folder was renamed.
///
/// Presets, history and secrets are keyed by script id and survive; the old
/// folder is kept as a `.backup-*` sibling. Refuses while a job of that script
/// is running — replacing files under a live run is a surprise the user did
/// not ask for, and unlike Remove there is no reason to kill the job.
#[tauri::command]
pub async fn repo_update(
    dir: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ScriptEntry> {
    let catalog = fresh_catalog(&state, false).await?;

    // The repo entry's manifest id is the join key with the installed script.
    let entry_id = catalog
        .entries
        .iter()
        .find(|e| e.dir == dir)
        .map(|e| e.id.clone())
        .ok_or_else(|| {
            AppError::Other(format!(
                "'{dir}' is not in the store catalog — press Refresh and try again"
            ))
        })?;

    let installed = {
        let scripts = state.scripts.lock().unwrap().clone();
        scripts
            .into_iter()
            .find(|s| s.id == entry_id)
            .ok_or_else(|| {
                AppError::Other(format!(
                    "'{dir}' is not installed — use Install, or Refresh if you just removed it"
                ))
            })?
    };

    if state.jobs.is_script_running(&installed.id) {
        return Err(AppError::Other(format!(
            "'{}' is running — stop it before updating",
            installed.name
        )));
    }

    let folder = installed
        .path
        .parent()
        .ok_or_else(|| {
            AppError::Other(format!("{} has no parent folder", installed.path.display()))
        })?
        .to_path_buf();

    let (target, _backup) = repo::update_in_place(&dir, &folder, &catalog, Some(&app)).await?;
    crate::commands::scripts::import_script(target, state).await
}

/// The session's catalog, refetching when the cache is missing or has expired
/// past [`repo::CATALOG_TTL`] — so an install or update always runs against a
/// reasonably current snapshot without re-asking GitHub on every click.
///
/// Locks are taken and dropped inside the blocks — no guard is ever held
/// across an await.
async fn fresh_catalog(state: &AppState, force: bool) -> Result<Arc<repo::Catalog>> {
    if !force {
        let guard = state.repo_catalog.lock().unwrap();
        if let Some(cached) = guard.as_ref() {
            if cached.is_fresh() {
                return Ok(cached.clone());
            }
        }
    }
    let catalog = Arc::new(repo::fetch_catalog().await?);
    *state.repo_catalog.lock().unwrap() = Some(catalog.clone());
    Ok(catalog)
}
