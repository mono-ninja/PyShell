use std::path::{Path, PathBuf};
use std::process::Stdio;

use tauri::AppHandle;
use tauri::Manager;
use tokio::process::Command;

use crate::error::{AppError, Result};

/// Resolve the uv sidecar binary path from the app resource dir.
/// In dev, it's src-tauri/binaries/. In production, Tauri bundles it.
pub fn uv_binary_path(app: &AppHandle) -> Result<PathBuf> {
    // Tauri external binaries are resolved with a target-triple suffix
    let target_triple = get_target_triple();

    let exe_dir = std::env::current_exe()
        .map_err(|e| AppError::Env(format!("cannot find exe: {}", e)))?
        .parent()
        .unwrap_or(Path::new("."))
        .to_path_buf();

    // Production: Tauri strips the target-triple suffix and bundles
    // `externalBin` binaries next to the main executable (e.g.
    // `Contents/MacOS/uv` in a macOS .app), not into the resource dir.
    let sidecar_name = if cfg!(windows) { "uv.exe" } else { "uv" };
    let bundled_candidate = exe_dir.join(sidecar_name);
    if bundled_candidate.exists() {
        return Ok(bundled_candidate);
    }

    // Also try resource dir, in case of a different bundling layout.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join(format!("uv-{}", target_triple));
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    // In dev, the binary is in src-tauri/binaries/
    let dev_candidate = exe_dir.join("binaries").join(format!("uv-{}", target_triple));
    if dev_candidate.exists() {
        return Ok(dev_candidate);
    }

    // Also try looking relative to CARGO_MANIFEST_DIR in dev
    let dev_candidate2 = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("uv-{}", target_triple));
    if dev_candidate2.exists() {
        return Ok(dev_candidate2);
    }

    Err(AppError::Env(format!(
        "uv sidecar binary not found (target: {}). Place it in src-tauri/binaries/",
        target_triple
    )))
}

fn get_target_triple() -> String {
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        "unknown"
    };

    let os = if cfg!(target_os = "macos") {
        "apple-darwin"
    } else if cfg!(target_os = "windows") {
        "pc-windows-msvc"
    } else if cfg!(target_os = "linux") {
        "unknown-linux-gnu"
    } else {
        "unknown"
    };

    format!("{}-{}", arch, os)
}

/// Run `uv venv` to create a virtual environment.
///
/// `--clear` makes this idempotent: "Rebuild env" calls `prepare_env` on a
/// "Ready" env whose directory already exists at the current env_key (the
/// cleanup loop only removes *sibling* dirs with different keys). Without
/// `--clear` uv refuses to overwrite an existing venv.
pub async fn create_venv(
    uv: &Path,
    venv_path: &Path,
    python_constraint: &str,
    cache_dir: &Path,
    python_install_dir: &Path,
) -> Result<String> {
    let mut cmd = Command::new(uv);
    cmd.arg("venv")
        .arg("--clear")
        .arg("--python")
        .arg(python_constraint)
        .arg(venv_path)
        .env("UV_CACHE_DIR", cache_dir)
        .env("UV_PYTHON_INSTALL_DIR", python_install_dir)
        .env("UV_NO_PROGRESS", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = cmd.output().await.map_err(|e| {
        AppError::Env(format!("failed to run uv venv: {}", e))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Env(format!(
            "uv venv failed: {}",
            stderr.lines().take(10).collect::<Vec<_>>().join("\n")
        )));
    }

    // Extract the Python version from stdout
    let stdout = String::from_utf8_lossy(&output.stdout);
    let python_version = stdout
        .lines()
        .find(|l| l.contains("Python") || l.contains("python"))
        .map(|l| l.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    Ok(python_version)
}

/// Install dependencies from a requirements.txt file into a venv.
/// Uses `uv pip install -r` (not `sync`) so transitive deps are resolved.
pub async fn pip_install(
    uv: &Path,
    requirements: &Path,
    venv_path: &Path,
    cache_dir: &Path,
    python_install_dir: &Path,
) -> Result<()> {
    let venv_python = venv_python_path(venv_path);

    let mut cmd = Command::new(uv);
    cmd.arg("pip")
        .arg("install")
        .arg("-r")
        .arg(requirements)
        .arg("--python")
        .arg(&venv_python)
        .env("UV_CACHE_DIR", cache_dir)
        .env("UV_PYTHON_INSTALL_DIR", python_install_dir)
        .env("UV_NO_PROGRESS", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = cmd.output().await.map_err(|e| {
        AppError::Env(format!("failed to run uv pip install: {}", e))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Env(format!(
            "uv pip install failed: {}",
            stderr.lines().take(10).collect::<Vec<_>>().join("\n")
        )));
    }

    Ok(())
}

/// Get the python binary path inside a venv.
pub fn venv_python_path(venv_path: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        venv_path.join("Scripts").join("python.exe")
    } else {
        venv_path.join("bin").join("python")
    }
}

/// Check if a venv exists at the given path.
pub fn venv_exists(venv_path: &Path) -> bool {
    venv_python_path(venv_path).exists()
}

/// Calculate the total size of a directory. Does not follow symlinks (audit M8).
pub fn dir_size(path: &Path) -> u64 {
    fn inner(path: &Path) -> u64 {
        let mut size = 0;
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                // Use symlink_metadata to detect symlinks without following them
                if let Ok(meta) = std::fs::symlink_metadata(entry.path()) {
                    if meta.file_type().is_symlink() {
                        // Don't follow symlinks — just count the link itself
                        size += meta.len();
                    } else if meta.is_dir() {
                        size += inner(&entry.path());
                    } else {
                        size += meta.len();
                    }
                }
            }
        }
        size
    }
    inner(path)
}
