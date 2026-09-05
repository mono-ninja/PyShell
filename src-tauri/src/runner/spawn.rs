use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;

use tauri::ipc::Channel;
use tokio::process::Command;

use crate::manifest::model::{ExitReason, JobEvent, JobId, ScriptSchema};
use crate::runner::args::{build_process_inputs, deps_env};
use crate::runner::group;
use crate::runner::stream::{stream_output, JobEventSender};
use crate::runner::registry::JobRegistry;

/// Spawn a script as a child process, streaming output via a Tauri Channel.
///
/// `deps` is the resolved `needs` map (id → folder) for scripts that declared
/// dependencies; it reaches the child as `PYSHELL_DEPS`.
///
/// `retention` is how many runs to keep per script — applied to **both** the
/// on-disk run folders and the History entries, from one user setting, so the
/// History tab can never offer Log/Files for a run whose folder has already
/// been pruned.
///
/// Returns the JobId immediately; the process runs in the background.
pub fn spawn_script(
    schema: &ScriptSchema,
    values: HashMap<String, serde_json::Value>,
    secrets: HashMap<String, String>,
    deps: HashMap<String, String>,
    python: PathBuf,
    channel: Channel<JobEvent>,
    registry: &JobRegistry,
    output_dir: PathBuf,
    state_dir: PathBuf,
    retention: usize,
    on_start: impl FnOnce(()) -> bool + Send + 'static,
    on_finish: impl FnOnce(bool, String) + Send + 'static,
) -> Result<JobId, String> {
    let job_id = uuid::Uuid::new_v4().to_string();
    let script_id = schema.id.clone();

    // Build argv, env, stdin from form values + schema
    let process_inputs = build_process_inputs(schema, &values, &secrets);

    // Set up output directory for this run
    let run_dir = output_dir.join(&script_id).join(&job_id);
    std::fs::create_dir_all(&run_dir).map_err(|e| e.to_string())?;

    // Write the full log to disk in parallel
    let log_file = run_dir.join("output.log");
    let log_file_writer =
        std::sync::Mutex::new(std::fs::File::create(&log_file).map_err(|e| e.to_string())?);

    let channel_sender = ChannelSender {
        channel: channel.clone(),
        log_writer: Arc::new(log_file_writer),
    };

    let entry = schema.runtime.entry.clone();
    let env_vars = process_inputs.env.clone();
    let argv = process_inputs.argv.clone();
    let stdin_content = process_inputs.stdin.clone();
    let temp_files = process_inputs.temp_files.clone();
    let timeout = schema.runtime.timeout;

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();

    // Atomically check-and-insert: prevents TOCTOU race on same-script re-run (audit H5)
    registry.try_insert(
        job_id.clone(),
        crate::runner::registry::JobHandle {
            script_id: script_id.clone(),
            cancel_tx,
        },
    ).map_err(|e| e)?;

    let registry_arc = registry.jobs_clone();
    let job_id_for_task = job_id.clone();

    // Spawn the async task
    tokio::spawn(async move {
        let has_access = on_start(());
        let script_id_for_finish = script_id.clone();

        // Send log file path to frontend via structured event
        channel_sender.send(JobEvent::Structured {
            event: serde_json::json!({
                "type": "log_file",
                "path": log_file.to_string_lossy(),
            }),
        });

        let mut cmd = Command::new(&python);
        cmd.arg(&entry)
            .args(&argv)
            .envs(&env_vars)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYSHELL_OUTPUT_DIR", &run_dir);
        // Cross-script dependencies, when the manifest declared any. Applied
        // before the stdio setup purely for locality with the other env lines.
        if let Some((name, value)) = deps_env(&deps) {
            cmd.env(name, value);
        }
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::piped());

        // Unix: setsid() in pre_exec so child becomes its own process group leader
        #[cfg(unix)]
        {
            unsafe {
                cmd.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }

        // Windows: CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP so we can assign
        // to a Job Object before any grandchildren spawn (Plan.md §M1)
        #[cfg(windows)]
        {
            // `creation_flags` is tokio's own inherent method (it forwards to
            // std's `CommandExt`), so importing that trait here only produces
            // an unused-import warning — and CI treats warnings as noise to
            // keep at zero.
            const CREATE_SUSPENDED: u32 = 0x00000004;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
            cmd.creation_flags(CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                channel_sender.send(JobEvent::Exit {
                    code: None,
                    duration_ms: 0,
                    reason: ExitReason::Error,
                });
                tracing::error!("Failed to spawn process: {}", e);
                registry_arc.lock().unwrap().remove(&job_id_for_task);
                let _ = std::fs::remove_dir_all(&run_dir);
                // Stop security-scoped access on error (audit M2)
                on_finish(has_access, script_id_for_finish);
                return;
            }
        };

        // Windows: assign the suspended process to a Job Object, then resume it.
        // Assignment must come first so grandchildren can't escape the job — but
        // the resume must happen even when assignment fails, otherwise the
        // process stays suspended forever: it would produce no output, never
        // exit, and (before the timeout fix) never be killed either.
        #[cfg(windows)]
        let job_handle = {
            let pid = child.id().unwrap_or(0);
            let job = match group::assign_to_job(&child) {
                Ok(handle) => Some(std::sync::Arc::new(handle)),
                Err(e) => {
                    tracing::error!(
                        "Failed to assign process {} to Job Object: {} — falling back to taskkill",
                        pid,
                        e
                    );
                    None
                }
            };

            if let Err(e) = group::resume_process(pid) {
                // Created suspended and unstartable — it can never run or exit,
                // so report it like a spawn failure instead of hanging the job.
                tracing::error!("Failed to resume suspended process {}: {}", pid, e);
                let _ = child.start_kill();
                channel_sender.send(JobEvent::Exit {
                    code: None,
                    duration_ms: 0,
                    reason: ExitReason::Error,
                });
                registry_arc.lock().unwrap().remove(&job_id_for_task);
                let _ = std::fs::remove_dir_all(&run_dir);
                on_finish(has_access, script_id_for_finish);
                return;
            }

            job
        };

        // Write stdin if provided
        if let Some(stdin_data) = &stdin_content {
            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(stdin_data.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
        } else {
            drop(child.stdin.take());
        }

        // Build the kill handle *before* `child` is moved into `stream_output`.
        // Both the timeout path (inside `stream_output`) and the cancel path
        // below have to kill this same tree, and neither can reach `child`
        // afterwards. On Unix pgid == pid because of the setsid() above; on
        // Windows the handle owns the Job Object.
        #[cfg(unix)]
        let killer = group::ProcessKiller::from_child(&child);
        #[cfg(windows)]
        let killer = group::ProcessKiller::new(job_handle, child.id().unwrap_or(0));

        // Stream output with timeout, or cancel.
        // We do NOT use kill_on_drop so we can do graceful SIGTERM → 3s → SIGKILL;
        // both exit paths go through `killer` instead.
        //
        // `job_start` is captured before the select! so the cancel path can
        // report the true run duration, not just the kill time (Plan.md §3.4).
        let job_start = Instant::now();
        let result = tokio::select! {
            result = stream_output(child, channel_sender.clone(), timeout, killer.clone()) => {
                result
            }
            _ = cancel_rx => {
                // Cancelled by user — kill the entire process group.
                killer.terminate_then_kill(group::KILL_GRACE).await;
                let duration_ms = job_start.elapsed().as_millis() as u64;
                // Send exit event so frontend knows the job ended
                channel_sender.send(JobEvent::Exit {
                    code: None,
                    duration_ms,
                    reason: ExitReason::Cancelled,
                });
                (None, duration_ms, ExitReason::Cancelled)
            }
        };

        // Clean up temp files
        for temp in &temp_files {
            let _ = std::fs::remove_file(temp);
        }

        // Output retention: keep only the last `retention` runs per script
        // (Plan.md §M5). Same number as the History cap below — one setting,
        // so the two lists never disagree about what exists.
        retain_last_runs(&output_dir, &script_id, retention);

        // Save history entry (Plan.md §M6)
        let (exit_code, duration_ms_val) = match &result {
            (code, dur, _) => (*code, *dur),
        };
        save_history_entry(
            &state_dir,
            &script_id,
            &job_id_for_task,
            &values,
            exit_code,
            duration_ms_val,
            retention,
        );

        // Remove from registry
        registry_arc.lock().unwrap().remove(&job_id_for_task);

        // Stop security-scoped access
        on_finish(has_access, script_id_for_finish);
    });

    Ok(job_id)
}

#[derive(Clone)]
pub struct ChannelSender {
    channel: Channel<JobEvent>,
    log_writer: Arc<std::sync::Mutex<std::fs::File>>,
}

impl JobEventSender for ChannelSender {
    fn send(&self, event: JobEvent) {
        // Write to disk log in parallel (all event types — audit #16)
        if let Ok(mut writer) = self.log_writer.lock() {
            use std::io::Write;
            match &event {
                JobEvent::Lines { batch } => {
                    for line in batch {
                        let _ = writeln!(writer, "{}", line.text);
                    }
                }
                JobEvent::Structured { event } => {
                    let _ = writeln!(
                        writer,
                        "[pyshell:structured] {}",
                        serde_json::to_string(event).unwrap_or_default()
                    );
                }
                JobEvent::Exit { code, duration_ms, reason } => {
                    let _ = writeln!(
                        writer,
                        "[pyshell:exit] code={:?} duration_ms={} reason={:?}",
                        code, duration_ms, reason
                    );
                }
            }
            let _ = writer.flush();
        }
        // Send to frontend
        let _ = self.channel.send(event);
    }
}

/// Remove old run directories, keeping only the N most recent (Plan.md §M5).
fn retain_last_runs(output_dir: &std::path::Path, script_id: &str, keep: usize) {
    let script_output = output_dir.join(script_id);
    if !script_output.exists() {
        return;
    }

    let mut entries: Vec<_> = match std::fs::read_dir(&script_output) {
        Ok(entries) => entries.flatten().collect(),
        Err(_) => return,
    };

    if entries.len() <= keep {
        return;
    }

    // Sort by modification time (newest first)
    entries.sort_by(|a, b| {
        b.metadata()
            .and_then(|m| m.modified())
            .ok()
            .cmp(&a.metadata().and_then(|m| m.modified()).ok())
    });

    for entry in entries.into_iter().skip(keep) {
        let _ = std::fs::remove_dir_all(entry.path());
    }
}

/// Save a history entry after a job finishes (Plan.md §M6). `keep` is the
/// retention setting — the same number that prunes run folders, so the History
/// list and the folders on disk stay in step.
fn save_history_entry(
    state_dir: &std::path::Path,
    script_id: &str,
    job_id: &str,
    values: &HashMap<String, serde_json::Value>,
    exit_code: Option<i32>,
    duration_ms: u64,
    keep: usize,
) {
    use crate::manifest::model::HistoryEntry;
    use crate::store;

    let mut current = store::state::load_script_state(state_dir, script_id);

    // Filter out secret sentinels before saving (Plan.md §2: last_values without secrets)
    let saved_values: HashMap<String, serde_json::Value> = values
        .iter()
        .filter(|(_, v)| {
            // Keep non-"__secret_set__" values; strip secret sentinel
            !(v.as_str() == Some("__secret_set__"))
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    let entry = HistoryEntry {
        timestamp: chrono::Local::now().to_rfc3339(),
        job_id: Some(job_id.to_string()),
        values: saved_values,
        exit_code,
        duration_ms,
    };

    current.history.push(entry);

    // Keep only the last `keep` entries (Plan.md §M6)
    if current.history.len() > keep {
        let start = current.history.len() - keep;
        current.history = current.history[start..].to_vec();
    }

    let _ = store::state::save_script_state(state_dir, script_id, &current);
}

// ---------------------------------------------------------------------------
// Tests (Plan.md §3.2)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn tmp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pyshell-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // --- retain_last_runs ---------------------------------------------------

    #[test]
    fn retain_last_runs_removes_oldest() {
        let dir = tmp_dir();
        let script_dir = dir.join("myscript");
        std::fs::create_dir_all(&script_dir).unwrap();

        // Create 5 run dirs with different mtimes
        for i in 0..5 {
            let run_dir = script_dir.join(format!("run-{}", i));
            std::fs::create_dir_all(&run_dir).unwrap();
            std::fs::write(run_dir.join("output.log"), format!("run {}", i)).unwrap();
            // Sleep to ensure different mtimes
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        retain_last_runs(&dir, "myscript", 3);

        let remaining: Vec<_> = std::fs::read_dir(&script_dir).unwrap().flatten().collect();
        assert_eq!(remaining.len(), 3, "should keep 3 newest runs");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn retain_last_runs_noop_when_under_limit() {
        let dir = tmp_dir();
        let script_dir = dir.join("myscript");
        std::fs::create_dir_all(&script_dir).unwrap();
        std::fs::create_dir_all(script_dir.join("run-1")).unwrap();
        std::fs::create_dir_all(script_dir.join("run-2")).unwrap();

        retain_last_runs(&dir, "myscript", 5);

        let remaining: Vec<_> = std::fs::read_dir(&script_dir).unwrap().flatten().collect();
        assert_eq!(remaining.len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn retain_last_runs_noop_when_dir_missing() {
        let dir = tmp_dir();
        retain_last_runs(&dir, "nonexistent", 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- save_history_entry -------------------------------------------------

    #[test]
    fn save_history_entry_appends_and_persists() {
        let dir = tmp_dir();

        let mut values = HashMap::new();
        values.insert("name".to_string(), serde_json::json!("test"));
        values.insert("count".to_string(), serde_json::json!(42));

        save_history_entry(&dir, "script1", "job-1", &values, Some(0), 1000, 50);

        let state = crate::store::state::load_script_state(&dir, "script1");
        assert_eq!(state.history.len(), 1);
        assert_eq!(state.history[0].job_id.as_deref(), Some("job-1"));
        assert_eq!(state.history[0].exit_code, Some(0));
        assert_eq!(state.history[0].duration_ms, 1000);
        assert_eq!(state.history[0].values.get("name").unwrap(), &serde_json::json!("test"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_history_entry_filters_secret_sentinels() {
        let dir = tmp_dir();

        let mut values = HashMap::new();
        values.insert("api_key".to_string(), serde_json::json!("__secret_set__"));
        values.insert("name".to_string(), serde_json::json!("test"));

        save_history_entry(&dir, "script1", "job-1", &values, Some(0), 100, 50);

        let state = crate::store::state::load_script_state(&dir, "script1");
        assert!(!state.history[0].values.contains_key("api_key"));
        assert!(state.history[0].values.contains_key("name"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_history_entry_caps_at_keep() {
        let dir = tmp_dir();
        let values = HashMap::new();

        for i in 0..55 {
            save_history_entry(&dir, "script1", &format!("job-{}", i), &values, Some(0), 100, 50);
        }

        let state = crate::store::state::load_script_state(&dir, "script1");
        assert_eq!(state.history.len(), 50);
        // The first 5 should have been trimmed
        assert_eq!(state.history[0].job_id.as_deref(), Some("job-5"));
        assert_eq!(state.history[49].job_id.as_deref(), Some("job-54"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_history_entry_honours_a_smaller_keep() {
        // The retention setting is user-tunable now; the cap must follow it
        // exactly rather than a hardcoded 50.
        let dir = tmp_dir();
        let values = HashMap::new();

        for i in 0..10 {
            save_history_entry(&dir, "script1", &format!("job-{}", i), &values, Some(0), 100, 3);
        }

        let state = crate::store::state::load_script_state(&dir, "script1");
        assert_eq!(state.history.len(), 3);
        assert_eq!(state.history[0].job_id.as_deref(), Some("job-7"));
        assert_eq!(state.history[2].job_id.as_deref(), Some("job-9"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
