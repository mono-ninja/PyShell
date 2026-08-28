use tauri::{AppHandle, Emitter, State};

use crate::env::manager;
use crate::error::{AppError, Result};
use crate::manifest::model::{DiskUsage, EnvStatus};
use crate::AppState;

/// Get the current env status for a script.
#[tauri::command]
pub async fn env_status(script_id: String, state: State<'_, AppState>) -> Result<EnvStatus> {
    let schema = load_schema(&state, &script_id)?
        .ok_or_else(|| AppError::ScriptNotFound(script_id))?;
    Ok(manager::get_env_status(&state, &schema))
}

/// List dependencies from a script's requirements file, for confirmation
/// before installation (Plan.md §M2).
#[tauri::command]
pub async fn list_dependencies(script_id: String, state: State<'_, AppState>) -> Result<Vec<String>> {
    let schema = load_schema(&state, &script_id)?
        .ok_or_else(|| AppError::ScriptNotFound(script_id))?;
    match &schema.runtime.requirements {
        Some(path) => {
            let content = std::fs::read_to_string(path)?;
            let deps: Vec<String> = content
                .lines()
                .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
                .map(|l| l.split(['=', '<', '>', '!']).next().unwrap_or(l).trim().to_string())
                .collect();
            Ok(deps)
        }
        None => Ok(vec![]),
    }
}

/// Prepare (create or rebuild) the venv for a script, emitting detailed
/// progress events via `env:{id}:progress` (Plan.md §M2).
#[tauri::command]
pub async fn prepare_env(
    app: AppHandle,
    script_id: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let schema = load_schema(&state, &script_id)?
        .ok_or_else(|| AppError::ScriptNotFound(script_id.clone()))?;

    tracing::info!("Preparing env for script {}", script_id);

    // Claim the build (Plan.md §M2 status, plus mutual exclusion). Two
    // concurrent prepares would otherwise run `uv venv` and `uv pip install`
    // against the same directory.
    if !state.try_claim_env_build(&script_id) {
        return Err(AppError::Env(format!(
            "environment for '{}' is already being prepared",
            script_id
        )));
    }

    // Every exit from here on has to release the claim, or the script stays
    // locked for the rest of the session — hence the single funnel below.
    let result = prepare_env_inner(&app, &state, &schema, &script_id).await;

    match &result {
        Ok(()) => state.release_env_build(&script_id),
        Err(e) => set_env_failed(&state, &script_id, &e.to_string()),
    }

    result
}

async fn prepare_env_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
    schema: &crate::manifest::model::ScriptSchema,
    script_id: &str,
) -> Result<()> {
    let script_id = script_id.to_string();

    let emit = |phase: &str, pct: f32, message: &str| {
        // Update building status
        {
            let mut building = state.env_building.lock().unwrap();
            building.insert(
                script_id.clone(),
                crate::manifest::model::EnvStatus::Building {
                    pct,
                    phase: phase.to_string(),
                },
            );
        }
        let _ = app.emit(
            &format!("env:{}:progress", script_id),
            serde_json::json!({"phase": phase, "pct": pct, "message": message}),
        );
    };

    // Phase 1: Create venv
    emit("python", 0.0, "Creating virtual environment...");

    let uv_bin = crate::env::uv::uv_binary_path(&app)?;
    let env_key = manager::compute_env_key(&schema);
    let env_path = manager::env_path_for(&state, &schema.id, &env_key);
    let cache_dir = manager::uv_cache_dir(&state);
    let python_install = manager::python_install_dir(&state);

    std::fs::create_dir_all(&cache_dir).ok();
    std::fs::create_dir_all(&python_install).ok();
    std::fs::create_dir_all(env_path.parent().unwrap_or(std::path::Path::new("."))).ok();

    // Clean up old envs — but not if a job is currently running for this script (audit M7)
    if !state.jobs.is_script_running(&schema.id) {
        let script_envs = state.envs_dir().join(&schema.id);
        if let Ok(entries) = std::fs::read_dir(&script_envs) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path != env_path && crate::env::uv::venv_exists(&path) {
                    let _ = std::fs::remove_dir_all(&path);
                }
            }
        }
    }

    // Failures propagate: the caller turns them into EnvStatus::Failed and
    // releases the build claim.
    crate::env::uv::create_venv(
        &uv_bin,
        &env_path,
        &schema.runtime.python,
        &cache_dir,
        &python_install,
    )
    .await?;

    // Phase 2: Install dependencies
    if let Some(requirements) = &schema.runtime.requirements {
        emit("deps", 50.0, "Installing dependencies...");
        crate::env::uv::pip_install(&uv_bin, requirements, &env_path, &cache_dir, &python_install)
            .await?;
    }

    emit("done", 100.0, "Environment ready");

    Ok(())
}

/// Reset (delete) the venv for a script.
#[tauri::command]
pub async fn reset_env(script_id: String, state: State<'_, AppState>) -> Result<()> {
    manager::reset_env(&state, &script_id)
}

/// Get total disk usage for envs and caches.
#[tauri::command]
pub async fn disk_usage(state: State<'_, AppState>) -> Result<DiskUsage> {
    Ok(manager::disk_usage(&state))
}

/// Garbage collect orphaned envs. Returns freed bytes.
#[tauri::command]
pub async fn gc_envs(state: State<'_, AppState>) -> Result<u64> {
    manager::gc_envs(&state)
}

/// Set env status to Failed (Plan.md §M2).
fn set_env_failed(state: &State<'_, AppState>, script_id: &str, message: &str) {
    state.env_building.lock().unwrap().insert(
        script_id.to_string(),
        crate::manifest::model::EnvStatus::Failed {
            message: message.to_string(),
        },
    );
}

fn load_schema(
    state: &State<'_, AppState>,
    script_id: &str,
) -> Result<Option<crate::manifest::model::ScriptSchema>> {
    let file = state
        .app_support_dir
        .join("schemas")
        .join(format!("{}.json", script_id));
    if !file.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&file)?;
    let schema: crate::manifest::model::ScriptSchema = serde_json::from_str(&content)?;
    Ok(Some(schema))
}
