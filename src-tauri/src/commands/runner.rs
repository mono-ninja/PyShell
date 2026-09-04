use std::collections::HashMap;

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::error::{AppError, Result};
use crate::manifest::model::{JobEvent, JobId, Artifact};
use crate::runner;
use crate::AppState;

/// Run a script: spawn a child process, stream output via Channel.
#[tauri::command]
pub async fn run_script(
    _app: AppHandle,
    script_id: String,
    values: HashMap<String, serde_json::Value>,
    on_event: Channel<JobEvent>,
    state: State<'_, AppState>,
) -> Result<JobId> {
    // Load schema
    let schema = load_schema(&state, &script_id)?
        .ok_or_else(|| AppError::ScriptNotFound(script_id.clone()))?;

    // Get python binary from env — no system Python fallback (Plan.md §0)
    let python = crate::env::manager::get_python_for_script(&state, &schema)
        .map_err(|e| AppError::Runner(format!(
            "environment not ready for script '{}': {}. Click Prepare Env first.",
            script_id, e
        )))?;

    // Load secrets from Keychain — fail if a required secret can't be loaded (audit M3)
    let secrets = load_secrets(&state, &script_id)?;

    // Resolve declared script dependencies (id → folder) for PYSHELL_DEPS.
    // Only installed ones resolve; the header pill has warned about the rest.
    let scripts = state.scripts.lock().unwrap().clone();
    let deps = runner::args::resolve_deps(&schema.needs, &scripts);
    drop(scripts);

    // Start security-scoped resource access (Plan.md §M6)
    // Access is maintained for the lifetime of the spawned task
    let bookmark_store = std::sync::Arc::new(crate::store::bookmarks::BookmarkStore::new(&state.app_support_dir));
    let bookmark_store_for_task = bookmark_store.clone();
    let script_id_for_bookmark = script_id.clone();

    // Spawn
    let job_id = runner::spawn::spawn_script(
        &schema,
        values,
        secrets,
        deps,
        python,
        on_event,
        &state.jobs,
        state.output_dir(),
        state.state_dir(),
        move |job_handle| {
            let _ = job_handle;
            let has_access = bookmark_store_for_task.start_access(&script_id_for_bookmark);
            has_access
        },
        move |has_access, script_id| {
            if has_access {
                bookmark_store.stop_access(&script_id);
            }
        },
    )
    .map_err(|e| AppError::Runner(e))?;

    tracing::info!("Started job {} for script {}", job_id, script_id);

    Ok(job_id)
}

/// Cancel a running job.
#[tauri::command]
pub async fn cancel_job(job_id: JobId, state: State<'_, AppState>) -> Result<()> {
    if state.jobs.cancel(&job_id) {
        tracing::info!("Cancelled job {}", job_id);
        Ok(())
    } else {
        Err(AppError::Runner(format!("job not found: {}", job_id)))
    }
}

/// Get artifacts produced by a job.
#[tauri::command]
pub async fn job_artifacts(job_id: JobId, state: State<'_, AppState>) -> Result<Vec<Artifact>> {
    let output_dir = state.output_dir();

    let mut artifacts = Vec::new();

    if let Ok(script_dirs) = std::fs::read_dir(&output_dir) {
        for script_dir in script_dirs.flatten() {
            let run_dir = script_dir.path().join(&job_id);
            if run_dir.exists() {
                artifacts = scan_artifacts(&run_dir, &schema_artifacts(&state, &script_dir.file_name().to_string_lossy())?)?;
                break;
            }
        }
    }

    Ok(artifacts)
}

/// Path of a past run's output directory (`output/{script_id}/{job_id}/`), used
/// to open its `output.log` or artifacts from the History tab (Plan.md §1.2).
/// Errors if the run dir no longer exists (pruned by retention).
#[tauri::command]
pub async fn job_run_dir(script_id: String, job_id: JobId, state: State<'_, AppState>) -> Result<String> {
    let run_dir = state.output_dir().join(&script_id).join(&job_id);
    if !run_dir.exists() {
        return Err(AppError::Other(format!(
            "run output for job '{}' no longer exists (pruned by retention)", job_id
        )));
    }
    Ok(run_dir.to_string_lossy().to_string())
}

fn scan_artifacts(dir: &std::path::Path, patterns: &[String]) -> Result<Vec<Artifact>> {
    let mut artifacts = Vec::new();

    for pattern in patterns {
        let full_pattern = dir.join(pattern);
        for entry in glob::glob(&full_pattern.to_string_lossy()).map_err(|e| AppError::Other(e.to_string()))?.flatten() {
            if entry.is_file() {
                let meta = std::fs::metadata(&entry)?;
                let name = entry
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                artifacts.push(Artifact {
                    path: entry.clone(),
                    name,
                    mime: guess_mime(&entry),
                    size_bytes: meta.len(),
                });
            }
        }
    }

    Ok(artifacts)
}

fn guess_mime(path: &std::path::Path) -> Option<String> {
    match path.extension().and_then(|e| e.to_str()) {
        Some("csv") => Some("text/csv".to_string()),
        Some("json") => Some("application/json".to_string()),
        Some("png") => Some("image/png".to_string()),
        Some("jpg") | Some("jpeg") => Some("image/jpeg".to_string()),
        Some("html") => Some("text/html".to_string()),
        Some("md") => Some("text/markdown".to_string()),
        _ => None,
    }
}

fn schema_artifacts(state: &State<'_, AppState>, script_id: &str) -> Result<Vec<String>> {
    let schema = load_schema(state, script_id)?;
    Ok(schema
        .map(|s| s.outputs.artifacts)
        .unwrap_or_default())
}

/// Load secrets from Keychain. Returns error if a secret field's value
/// can't be loaded (audit M3 — don't silently run without secrets).
fn load_secrets(state: &AppState, script_id: &str) -> Result<HashMap<String, String>> {
    use crate::manifest::model::InputType;
    let mut secrets = HashMap::new();

    let schema_file = state.app_support_dir.join("schemas").join(format!("{}.json", script_id));
    if !schema_file.exists() {
        return Ok(secrets);
    }
    let content = std::fs::read_to_string(&schema_file)?;
    let schema: crate::manifest::model::ScriptSchema = serde_json::from_str(&content)?;

    for input in &schema.inputs {
        if matches!(input.r#type, InputType::Secret) {
            let entry = keyring::Entry::new("com.pyshell.app", &format!("{}:{}", script_id, input.key))
                .map_err(|e| AppError::Secret(format!("failed to access keychain for '{}': {}", input.key, e)))?;

            match entry.get_password() {
                Ok(password) => {
                    secrets.insert(input.key.clone(), password);
                }
                Err(keyring::Error::NoEntry) => {
                    // Secret not set — skip, the form value will be the sentinel
                    tracing::warn!("Secret '{}' not set for script '{}'", input.key, script_id);
                }
                Err(e) => {
                    return Err(AppError::Secret(format!(
                        "failed to read secret '{}' from keychain: {}", input.key, e
                    )));
                }
            }
        }
    }

    Ok(secrets)
}

fn load_schema(
    state: &State<'_, AppState>,
    script_id: &str,
) -> Result<Option<crate::manifest::model::ScriptSchema>> {
    let file = state.app_support_dir.join("schemas").join(format!("{}.json", script_id));
    if !file.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&file)?;
    let schema: crate::manifest::model::ScriptSchema = serde_json::from_str(&content)?;
    Ok(Some(schema))
}

/// Preview the command line that `run_script` would execute, without actually
/// spawning anything (Plan.md §1.6). Secrets are masked as `***`.
#[tauri::command]
pub async fn preview_command(
    script_id: String,
    values: HashMap<String, serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<CommandPreview> {
    use crate::manifest::model::InputType;
    use crate::runner::args::build_process_inputs;

    let schema = load_schema(&state, &script_id)?
        .ok_or_else(|| AppError::ScriptNotFound(script_id.clone()))?;

    // Use placeholder secrets so the preview shows `***` without touching Keychain.
    let mut fake_secrets = HashMap::new();
    for input in &schema.inputs {
        if matches!(input.r#type, InputType::Secret) {
            fake_secrets.insert(input.key.clone(), "***".to_string());
        }
    }

    let inputs = build_process_inputs(&schema, &values, &fake_secrets);

    // Format argv as a shell-quoted command line.
    let python = crate::env::manager::get_python_for_script(&state, &schema)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "<python>".to_string());

    let entry = schema.runtime.entry.to_string_lossy().to_string();
    let mut argv = inputs.argv.clone();
    let quoted: Vec<String> = std::iter::once(python)
        .chain(std::iter::once(entry))
        .chain(argv.drain(..))
        .map(|arg| shell_quote(&arg))
        .collect();

    Ok(CommandPreview {
        command: quoted.join(" "),
        env: inputs.env,
    })
}

/// Shell-quote a single argument, matching the POSIX rules closely enough for
/// display. A string with no special characters is returned as-is; otherwise
/// it's wrapped in single quotes with embedded single quotes escaped.
fn shell_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    if s.chars().all(|c| c.is_alphanumeric() || "@%_+-=.,:/\\~".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct CommandPreview {
    pub command: String,
    pub env: HashMap<String, String>,
}
