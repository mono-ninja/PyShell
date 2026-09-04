#![allow(unexpected_cfgs)]

mod commands;
mod env;
mod error;
mod logging;
mod manifest;
mod menu;
mod repo;
mod runner;
mod store;

use std::sync::{Arc, Mutex};

use runner::registry::JobRegistry;
use tauri::Manager;

pub struct AppState {
    pub scripts: Mutex<Vec<manifest::model::ScriptEntry>>,
    pub jobs: JobRegistry,
    pub app_support_dir: std::path::PathBuf,
    pub env_building: Mutex<std::collections::HashMap<String, manifest::model::EnvStatus>>,
    pub watcher_tx: Mutex<Option<std::sync::mpsc::Sender<manifest::watcher::WatchCommand>>>,
    /// What the native Favorites submenu currently shows, so a menu rebuild is
    /// skipped when nothing about the pinned scripts changed.
    pub menu_favorites: Mutex<Vec<menu::Favorite>>,
    /// The Script Store catalog for this session. Fetched on first open of the
    /// dialog and kept so installs don't re-ask the GitHub API (60 requests/h
    /// unauthenticated); the dialog's Refresh replaces it wholesale.
    pub repo_catalog: Mutex<Option<Arc<repo::Catalog>>>,
}

impl AppState {
    pub fn new(app_support_dir: std::path::PathBuf) -> Self {
        Self {
            scripts: Mutex::new(Vec::new()),
            jobs: JobRegistry::new(),
            app_support_dir,
            env_building: Mutex::new(std::collections::HashMap::new()),
            watcher_tx: Mutex::new(None),
            menu_favorites: Mutex::new(Vec::new()),
            repo_catalog: Mutex::new(None),
        }
    }

    /// Atomically claim the right to build a script's env, so two concurrent
    /// `prepare_env` calls can't run `uv venv` / `uv pip install` against the
    /// same directory. Returns false if a build is already in flight.
    ///
    /// Check-and-insert happens under a single lock (same reason as
    /// `JobRegistry::try_insert`). Every path out of `prepare_env` must then
    /// release the claim, or the script stays locked for the rest of the session.
    pub fn try_claim_env_build(&self, script_id: &str) -> bool {
        let mut building = self.env_building.lock().unwrap();
        if matches!(
            building.get(script_id),
            Some(manifest::model::EnvStatus::Building { .. })
        ) {
            return false;
        }
        building.insert(
            script_id.to_string(),
            manifest::model::EnvStatus::Building {
                pct: 0.0,
                phase: "starting".to_string(),
            },
        );
        true
    }

    pub fn release_env_build(&self, script_id: &str) {
        self.env_building.lock().unwrap().remove(script_id);
    }

    pub fn envs_dir(&self) -> std::path::PathBuf {
        self.app_support_dir.join("envs")
    }

    pub fn output_dir(&self) -> std::path::PathBuf {
        self.app_support_dir.join("output")
    }

    pub fn state_dir(&self) -> std::path::PathBuf {
        self.app_support_dir.join("state")
    }

    pub fn logs_dir(&self) -> std::path::PathBuf {
        self.app_support_dir.join("logs")
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let app_support_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&app_support_dir).ok();

            let state = AppState::new(app_support_dir);
            std::fs::create_dir_all(state.envs_dir()).ok();
            std::fs::create_dir_all(state.output_dir()).ok();
            std::fs::create_dir_all(state.state_dir()).ok();
            std::fs::create_dir_all(state.logs_dir()).ok();

            logging::init(&state.logs_dir());

            tracing::info!("PyShell starting up");

            // Load persisted script list
            let scripts = store::state::load_script_list(&state.app_support_dir);

            // Resolve bookmarks and re-check reachability at startup (Plan.md §M6)
            {
                let bookmark_store = store::bookmarks::BookmarkStore::new(&state.app_support_dir);
                let resolved: Vec<_> = scripts.iter().map(|s| {
                    let mut s = s.clone();
                    if let Some(resolved) = bookmark_store.resolve_bookmark(&s.id) {
                        if s.path != resolved && resolved.exists() {
                            s.path = resolved;
                        }
                    }
                    s.reachable = s.path.exists();
                    s
                }).collect();
                store::state::save_script_list(&state.app_support_dir, &resolved).ok();
                *state.scripts.lock().unwrap() = resolved;
            }

            // Re-validate manifests so a pyshell.yaml that broke while the app
            // was closed is surfaced immediately (Plan.md §0 schema_error).
            commands::scripts::validate_schema_errors(&state);

            // The full native menu (menu.rs explains why it is load-bearing).
            // Built after the script list, because the Favorites submenu carries
            // the pinned scripts' names.
            {
                let ids: Vec<String> = state
                    .scripts
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|s| s.id.clone())
                    .collect();
                let pinned = store::favorites::load(&state.app_support_dir, &ids);
                let items = commands::favorites::label_favorites(&state, &pinned);
                app.set_menu(menu::build(app, &items)?)?;
                *state.menu_favorites.lock().unwrap() = items;
            }

            // ⌘W / the red traffic light hide the window instead of closing it,
            // the way a single-window macOS app is expected to behave: the
            // webview survives, so form values, the log buffer and the selected
            // script are still there when the dock icon brings it back. Closing
            // for real would drop all of that while the run kept going in the
            // background. Quitting stays ⌘Q, which still reaches RunEvent::Exit.
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let hide_target = window.clone();
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = hide_target.hide();
                        }
                    });
                }
            }

            // macOS vibrancy (Plan.md §M0)
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    use window_vibrancy::apply_vibrancy;
                    use window_vibrancy::NSVisualEffectMaterial;
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::Sidebar,
                        None,
                        None,
                    );
                }
            }

            app.manage(state);

            // Start manifest watcher (Plan.md §M3). The sender is stored in
            // AppState so import_script/remove_script can add/remove paths
            // dynamically (Plan.md §3.4).
            let app_handle = app.handle().clone();
            let watcher_tx = manifest::watcher::start_watcher(app_handle);
            let managed_state: tauri::State<AppState> = app.state();
            *managed_state.watcher_tx.lock().unwrap() = Some(watcher_tx);

            Ok(())
        })
        .on_menu_event(menu::handle_event)
        .invoke_handler(tauri::generate_handler![
            commands::scripts::import_script,
            commands::scripts::list_scripts,
            commands::scripts::get_schema,
            commands::scripts::reload_schema,
            commands::scripts::relink_script,
            commands::scripts::remove_script,
            commands::scripts::duplicate_script,
            commands::scripts::introspect_script,
            commands::scripts::save_generated_manifest,
            commands::scripts::script_readme,
            commands::scripts::script_folder,
            commands::scripts::open_in_pycharm,
            commands::scripts::open_in_terminal,
            commands::repo::repo_catalog,
            commands::repo::repo_install,
            commands::repo::repo_update,
            commands::favorites::list_favorites,
            commands::favorites::toggle_favorite,
            commands::runner::run_script,
            commands::runner::cancel_job,
            commands::runner::job_artifacts,
            commands::runner::job_run_dir,
            commands::runner::preview_command,
            commands::env::env_status,
            commands::env::prepare_env,
            commands::env::list_dependencies,
            commands::env::reset_env,
            commands::env::disk_usage,
            commands::env::gc_envs,
            commands::secrets::set_secret,
            commands::secrets::has_secret,
            commands::secrets::delete_secret,
            commands::state::get_state,
            commands::state::save_preset,
            commands::state::delete_preset,
            commands::state::rename_preset,
            commands::state::save_last_values,
            commands::state::import_presets,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::Exit => {
                tracing::info!("App exiting — cancelling all jobs");
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.jobs.cancel_all();
                }
            }
            // ⌘W hid the window rather than destroying it, so the dock icon has
            // to bring it back — otherwise the app is running with no way to
            // reach it. Jobs keep streaming into the hidden webview meanwhile,
            // which is the point of hiding instead of closing.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => {
                if !has_visible_windows {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            _ => {}
        });
}
