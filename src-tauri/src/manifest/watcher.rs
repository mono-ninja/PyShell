use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use notify::{event::EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

/// Commands sent to the watcher thread to dynamically add/remove paths
/// (Plan.md §3.4: previously paths were registered only at startup, so
/// scripts imported during a session were not watched until restart).
pub enum WatchCommand {
    Add(Vec<PathBuf>),
    Remove(Vec<PathBuf>),
}

/// Start watching manifest files for changes. When a `pyshell.yaml` or the
/// script `.py` file changes, emit a `scripts:changed` global event so the
/// frontend can reload the schema (Plan.md §M3).
///
/// Returns a sender that can be used to add/remove paths dynamically.
pub fn start_watcher(app: AppHandle) -> std::sync::mpsc::Sender<WatchCommand> {
    let state: tauri::State<crate::AppState> = app.state();
    let scripts = state.scripts.lock().unwrap().clone();

    // Collect all paths to watch: each script's .py file, its pyshell.yaml,
    // and its requirements.txt (if declared in the saved schema). Watching
    // requirements.txt lets the env pill flip to "Stale" the moment deps
    // change, without re-selecting the script.
    let mut paths_to_watch: Vec<PathBuf> = Vec::new();
    for script in &scripts {
        paths_to_watch.extend(crate::commands::scripts::watch_paths_for(script, &state));
    }

    if paths_to_watch.is_empty() {
        tracing::info!("No manifest/script paths to watch yet");
    }

    let app_handle = app.clone();
    let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<WatchCommand>();

    // Use a debounced watcher to avoid firing on every byte write
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();

        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                tracing::error!("Failed to create file watcher: {}", e);
                return;
            }
        };

        // Refcount for watched paths: multiple scripts in the same folder share
        // a pyshell.yaml, so removing one must not unwatch a path the other
        // still needs.
        let mut refcounts: HashMap<PathBuf, usize> = HashMap::new();

        for path in &paths_to_watch {
            *refcounts.entry(path.clone()).or_insert(0) += 1;
            if let Err(e) = watcher.watch(path, RecursiveMode::NonRecursive) {
                tracing::warn!("Failed to watch {}: {}", path.display(), e);
            }
        }

        tracing::info!("Watching {} manifest/script paths", refcounts.len());

        // Debounce: collect events for 500ms, then emit once
        let mut last_emit = std::time::Instant::now();
        let debounce = Duration::from_millis(500);

        loop {
            let event = match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(e) => e,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // Check for add/remove commands between event polls
                    while let Ok(cmd) = cmd_rx.try_recv() {
                        match cmd {
                            WatchCommand::Add(paths) => {
                                for path in &paths {
                                    let count = refcounts.entry(path.clone()).or_insert(0);
                                    *count += 1;
                                    if *count == 1 {
                                        if let Err(e) = watcher.watch(path, RecursiveMode::NonRecursive) {
                                            tracing::warn!("Failed to watch {}: {}", path.display(), e);
                                        } else {
                                            tracing::info!("Now watching {}", path.display());
                                        }
                                    }
                                }
                            }
                            WatchCommand::Remove(paths) => {
                                for path in &paths {
                                    if let Some(count) = refcounts.get_mut(path) {
                                        *count = count.saturating_sub(1);
                                        if *count == 0 {
                                            refcounts.remove(path);
                                            let _ = watcher.unwatch(path);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    continue;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            };

            match event {
                Ok(e) => {
                    if matches!(
                        e.kind,
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                    ) {
                        if last_emit.elapsed() >= debounce {
                            tracing::info!("Manifest/script changed, emitting scripts:changed");
                            let _ = app_handle.emit("scripts:changed", ());
                            last_emit = std::time::Instant::now();
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("Watch error: {}", e);
                }
            }
        }
    });

    cmd_tx
}
