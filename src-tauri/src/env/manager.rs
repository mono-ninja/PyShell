use std::path::{Path, PathBuf};

use crate::env::hash;
use crate::env::uv;
use crate::error::{AppError, Result};
use crate::manifest::model::{EnvStatus, ScriptSchema};
use crate::AppState;

/// The env manager handles the lifecycle of per-script venvs.
///
/// Directory layout: {app_support}/envs/{script_id}/{env_key}/
/// Cache: {app_support}/uv_cache/
/// Python installs: {app_support}/python_install/

pub fn env_path_for(state: &AppState, script_id: &str, env_key: &str) -> PathBuf {
    state.envs_dir().join(script_id).join(env_key)
}

pub fn uv_cache_dir(state: &AppState) -> PathBuf {
    state.app_support_dir.join("uv_cache")
}

pub fn python_install_dir(state: &AppState) -> PathBuf {
    state.app_support_dir.join("python_install")
}

/// Compute the current env_key for a script based on its requirements + python constraint.
pub fn compute_env_key(schema: &ScriptSchema) -> String {
    let python = &schema.runtime.python;
    match &schema.runtime.requirements {
        Some(req_path) => {
            let content = std::fs::read_to_string(req_path).unwrap_or_default();
            hash::compute_env_key(&content, python)
        }
        None => hash::compute_env_key_no_deps(python),
    }
}

/// Get the current env status for a script.
pub fn get_env_status(state: &AppState, schema: &ScriptSchema) -> EnvStatus {
    // Check if env is currently building or failed (Plan.md §M2)
    if let Some(status) = state.env_building.lock().unwrap().get(&schema.id) {
        return status.clone();
    }

    let env_key = compute_env_key(schema);
    let env_path = env_path_for(state, &schema.id, &env_key);

    if uv::venv_exists(&env_path) {
        let size = uv::dir_size(&env_path);
        let python_version = get_python_version(&env_path);
        EnvStatus::Ready {
            size_bytes: size,
            python: python_version,
        }
    } else {
        // Check if any old env exists (stale)
        let script_envs = state.envs_dir().join(&schema.id);
        if script_envs.exists() {
            if let Ok(entries) = std::fs::read_dir(&script_envs) {
                for entry in entries.flatten() {
                    if uv::venv_exists(&entry.path()) {
                        return EnvStatus::Stale {
                            reason: "requirements or python version changed".to_string(),
                        };
                    }
                }
            }
        }
        EnvStatus::Missing
    }
}

fn get_python_version(venv_path: &Path) -> String {
    let python = uv::venv_python_path(venv_path);
    let output = std::process::Command::new(&python)
        .arg("--version")
        .output();

    match output {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                String::from_utf8_lossy(&o.stderr).trim().to_string()
            } else {
                s
            }
        }
        Err(_) => "unknown".to_string(),
    }
}

/// Reset (delete) the venv for a script. Refuses if a job is running.
pub fn reset_env(state: &AppState, script_id: &str) -> Result<()> {
    if state.jobs.is_script_running(script_id) {
        return Err(AppError::Runner(format!(
            "cannot reset env: a job is currently running for script '{}'", script_id
        )));
    }
    let script_envs = state.envs_dir().join(script_id);
    if script_envs.exists() {
        std::fs::remove_dir_all(&script_envs)?;
    }
    Ok(())
}

/// Get the python binary path for a script's current env.
pub fn get_python_for_script(state: &AppState, schema: &ScriptSchema) -> Result<PathBuf> {
    let env_key = compute_env_key(schema);
    let env_path = env_path_for(state, &schema.id, &env_key);

    if !uv::venv_exists(&env_path) {
        return Err(AppError::Env(format!(
            "environment not ready for script '{}'. Call prepare_env first.",
            schema.id
        )));
    }

    Ok(uv::venv_python_path(&env_path))
}

/// Garbage collect orphaned envs. Two kinds of orphan:
///
/// 1. `envs/{script_id}/` for a script that is no longer in the script list —
///    `remove_script(delete_env: false)` leaves these behind. These are exactly
///    what [`disk_usage`] reports as `orphaned_bytes`, so GC must free them or
///    the UI shows disk usage that nothing can reclaim.
/// 2. `envs/{script_id}/{env_key}/` for an env_key that is no longer current,
///    i.e. the requirements or the python constraint changed. `prepare_env`
///    clears these for the script it is preparing, so they only linger for
///    scripts that were left stale.
///
/// Envs for a script with a running job, or one currently being built, are
/// never touched.
pub fn gc_envs(state: &AppState) -> Result<u64> {
    let mut freed_bytes: u64 = 0;
    let envs_dir = state.envs_dir();

    let known: std::collections::HashSet<String> = state
        .scripts
        .lock()
        .unwrap()
        .iter()
        .map(|s| s.id.clone())
        .collect();

    let Ok(entries) = std::fs::read_dir(&envs_dir) else {
        return Ok(0);
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let script_id = entry.file_name().to_string_lossy().to_string();

        if state.jobs.is_script_running(&script_id)
            || state.env_building.lock().unwrap().contains_key(&script_id)
        {
            continue;
        }

        // (1) No owner left — drop the whole directory.
        if !known.contains(&script_id) {
            freed_bytes += uv::dir_size(&path);
            let _ = std::fs::remove_dir_all(&path);
            continue;
        }

        // (2) Owned: keep only the env matching the current key. If the schema
        // can't be read we can't know which that is, so leave the script alone.
        let Some(current_key) = current_env_key(state, &script_id) else {
            continue;
        };

        if let Ok(env_entries) = std::fs::read_dir(&path) {
            for env_entry in env_entries.flatten() {
                let env_path = env_entry.path();
                if !env_path.is_dir() || env_entry.file_name().to_string_lossy() == current_key {
                    continue;
                }
                freed_bytes += uv::dir_size(&env_path);
                let _ = std::fs::remove_dir_all(&env_path);
            }
        }
    }

    Ok(freed_bytes)
}

/// The env_key a script's schema currently resolves to, or `None` if its saved
/// schema is missing or unreadable.
fn current_env_key(state: &AppState, script_id: &str) -> Option<String> {
    let file = state
        .app_support_dir
        .join("schemas")
        .join(format!("{}.json", script_id));
    let content = std::fs::read_to_string(file).ok()?;
    let schema: ScriptSchema = serde_json::from_str(&content).ok()?;
    Some(compute_env_key(&schema))
}

/// Compute total disk usage.
pub fn disk_usage(state: &AppState) -> crate::manifest::model::DiskUsage {
    let envs_dir = state.envs_dir();
    let cache_dir = uv_cache_dir(state);
    let output_dir = state.output_dir();

    let envs_bytes = uv::dir_size(&envs_dir);
    let uv_cache_bytes = uv::dir_size(&cache_dir);
    let output_bytes = uv::dir_size(&output_dir);
    let total_bytes = envs_bytes + uv_cache_bytes + output_bytes;

    let mut per_script: Vec<(String, u64)> = Vec::new();
    let mut orphaned_bytes: u64 = 0;

    let scripts = state.scripts.lock().unwrap().clone();

    if let Ok(entries) = std::fs::read_dir(&envs_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let script_id = entry.file_name().to_string_lossy().to_string();
            let size = uv::dir_size(&path);

            if scripts.iter().any(|s| s.id == script_id) {
                per_script.push((script_id, size));
            } else {
                orphaned_bytes += size;
            }
        }
    }

    crate::manifest::model::DiskUsage {
        total_bytes,
        uv_cache_bytes,
        output_bytes,
        per_script,
        orphaned_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::model::{Outputs, Runtime, SchemaSource, ScriptEntry};

    struct TempState {
        state: AppState,
        dir: PathBuf,
    }

    impl Drop for TempState {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn temp_state() -> TempState {
        let dir = std::env::temp_dir().join(format!("pyshell-gc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("envs")).unwrap();
        std::fs::create_dir_all(dir.join("schemas")).unwrap();
        TempState { state: AppState::new(dir.clone()), dir }
    }

    fn schema_for(id: &str, python: &str) -> ScriptSchema {
        ScriptSchema {
            schema: 1,
            id: id.to_string(),
            name: id.to_string(),
            version: None,
            description: None,
            icon: None,
            category: None,
            needs: Vec::new(),
            runtime: Runtime {
                entry: PathBuf::from("main.py"),
                python: python.to_string(),
                requirements: None,
                timeout: None,
            },
            inputs: vec![],
            outputs: Outputs { artifacts: vec![], result: None },
            source: SchemaSource::Yaml,
        }
    }

    /// Register a script: script list entry + saved schema, as `import_script` does.
    fn register(ts: &TempState, id: &str, python: &str) -> String {
        let schema = schema_for(id, python);
        let file = ts.dir.join("schemas").join(format!("{}.json", id));
        std::fs::write(&file, serde_json::to_string(&schema).unwrap()).unwrap();

        ts.state.scripts.lock().unwrap().push(ScriptEntry {
            id: id.to_string(),
            name: id.to_string(),
            icon: None,
            category: None,
            needs: Vec::new(),
            path: PathBuf::from("/tmp/main.py"),
            source: SchemaSource::Yaml,
            reachable: true,
            schema_error: None,
        });

        compute_env_key(&schema)
    }

    /// A directory that looks like a real venv, with `bytes` of payload.
    fn fake_venv(root: &Path, bytes: usize) {
        let python = uv::venv_python_path(root);
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, vec![b'x'; bytes]).unwrap();
    }

    #[test]
    fn gc_removes_envs_whose_script_is_gone() {
        let ts = temp_state();
        // No entry in the script list: this is what remove_script(delete_env: false)
        // leaves behind, and what disk_usage reports as orphaned_bytes.
        fake_venv(&ts.dir.join("envs/ghost/somekey"), 128);

        let freed = gc_envs(&ts.state).unwrap();

        assert!(freed >= 128, "freed {} bytes", freed);
        assert!(!ts.dir.join("envs/ghost").exists(), "orphaned env survived gc");
    }

    #[test]
    fn gc_keeps_the_current_env_of_a_known_script() {
        let ts = temp_state();
        let key = register(&ts, "keeper", ">=3.11");
        fake_venv(&ts.dir.join("envs/keeper").join(&key), 64);

        let freed = gc_envs(&ts.state).unwrap();

        assert_eq!(freed, 0, "gc must not touch a live env");
        assert!(uv::venv_exists(&ts.dir.join("envs/keeper").join(&key)));
    }

    #[test]
    fn gc_removes_stale_env_keys_but_keeps_the_current_one() {
        let ts = temp_state();
        let key = register(&ts, "mixed", ">=3.11");
        fake_venv(&ts.dir.join("envs/mixed").join(&key), 64);
        fake_venv(&ts.dir.join("envs/mixed/stale-key-from-old-requirements"), 256);

        let freed = gc_envs(&ts.state).unwrap();

        assert!(freed >= 256, "freed {} bytes", freed);
        assert!(uv::venv_exists(&ts.dir.join("envs/mixed").join(&key)), "current env was deleted");
        assert!(!ts.dir.join("envs/mixed/stale-key-from-old-requirements").exists());
    }

    #[test]
    fn gc_skips_a_script_whose_env_is_being_built() {
        let ts = temp_state();
        fake_venv(&ts.dir.join("envs/ghost/somekey"), 128);
        assert!(ts.state.try_claim_env_build("ghost"));

        let freed = gc_envs(&ts.state).unwrap();

        assert_eq!(freed, 0);
        assert!(ts.dir.join("envs/ghost").exists(), "gc deleted an env mid-build");
    }

    #[test]
    fn gc_leaves_a_known_script_alone_when_its_schema_is_unreadable() {
        let ts = temp_state();
        // In the script list, but no saved schema — we can't know the current key.
        ts.state.scripts.lock().unwrap().push(ScriptEntry {
            id: "noschema".into(),
            name: "noschema".into(),
            icon: None,
            category: None,
            needs: Vec::new(),
            path: PathBuf::from("/tmp/main.py"),
            source: SchemaSource::Yaml,
            reachable: true,
            schema_error: None,
        });
        fake_venv(&ts.dir.join("envs/noschema/somekey"), 128);

        let freed = gc_envs(&ts.state).unwrap();

        assert_eq!(freed, 0);
        assert!(ts.dir.join("envs/noschema/somekey").exists());
    }

    #[test]
    fn disk_usage_and_gc_agree_on_what_is_orphaned() {
        let ts = temp_state();
        let key = register(&ts, "owned", ">=3.11");
        fake_venv(&ts.dir.join("envs/owned").join(&key), 64);
        fake_venv(&ts.dir.join("envs/ghost/k"), 256);

        let before = disk_usage(&ts.state);
        assert!(before.orphaned_bytes >= 256, "{:?}", before.orphaned_bytes);

        let freed = gc_envs(&ts.state).unwrap();
        assert!(freed >= before.orphaned_bytes);

        // What the UI reported as reclaimable is actually gone now.
        let after = disk_usage(&ts.state);
        assert_eq!(after.orphaned_bytes, 0);
    }

    // --- prepare_env mutual exclusion ---

    #[test]
    fn a_second_env_build_claim_is_refused() {
        let ts = temp_state();
        assert!(ts.state.try_claim_env_build("s"), "first claim should win");
        assert!(!ts.state.try_claim_env_build("s"), "second claim must be refused");
    }

    #[test]
    fn releasing_a_claim_allows_the_next_build() {
        let ts = temp_state();
        assert!(ts.state.try_claim_env_build("s"));
        ts.state.release_env_build("s");
        assert!(ts.state.try_claim_env_build("s"));
    }

    #[test]
    fn a_failed_build_does_not_lock_the_script_forever() {
        let ts = temp_state();
        assert!(ts.state.try_claim_env_build("s"));
        // What prepare_env's error funnel does: overwrite Building with Failed.
        ts.state.env_building.lock().unwrap().insert(
            "s".to_string(),
            EnvStatus::Failed { message: "boom".into() },
        );
        assert!(ts.state.try_claim_env_build("s"), "a failed build must be retryable");
    }

    #[test]
    fn claims_are_per_script() {
        let ts = temp_state();
        assert!(ts.state.try_claim_env_build("a"));
        assert!(ts.state.try_claim_env_build("b"));
    }
}
