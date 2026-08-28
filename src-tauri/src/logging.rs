use std::path::Path;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

static LOG_DIR: OnceLock<std::path::PathBuf> = OnceLock::new();

// Store the guard so it's dropped on app exit, flushing buffered logs (audit M16)
static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

pub fn init(log_dir: &Path) {
    let file_appender = tracing_appender::rolling::daily(log_dir, "pyshell.log");
    let (non_blocking_file, guard) = tracing_appender::non_blocking(file_appender);

    // Store the guard so it lives until process exit, flushing remaining logs
    let _ = LOG_GUARD.set(guard);

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,pyshell_lib=debug"));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(
            fmt::layer()
                .with_writer(std::io::stderr)
                .with_target(false),
        )
        .with(
            fmt::layer()
                .with_ansi(false)
                .with_writer(non_blocking_file)
                .with_target(true),
        )
        .init();

    let _ = LOG_DIR.set(log_dir.to_path_buf());

    tracing::info!("Logging initialized, log dir: {}", log_dir.display());
}

pub fn show_logs_in_finder(app: &AppHandle) {
    let dir = LOG_DIR.get().cloned().unwrap_or_else(|| {
        let state: tauri::State<crate::AppState> = app.state();
        state.logs_dir()
    });
    if let Err(e) = tauri_plugin_opener::open_path(dir.to_string_lossy().to_string(), None::<&str>) {
        tracing::error!("Failed to open logs dir: {}", e);
    }
}
