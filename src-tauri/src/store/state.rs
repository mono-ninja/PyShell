use std::path::{Path, PathBuf};

use crate::error::Result;
use crate::manifest::model::{ScriptEntry, ScriptState};

/// Load the list of imported scripts from app support dir.
pub fn load_script_list(app_support: &Path) -> Vec<ScriptEntry> {
    let list_file = app_support.join("scripts.json");
    match std::fs::read_to_string(&list_file) {
        Ok(content) => {
            match serde_json::from_str::<Vec<ScriptEntry>>(&content) {
                Ok(scripts) => scripts,
                Err(e) => {
                    tracing::error!("Failed to parse scripts.json (corrupted?): {}", e);
                    Vec::new()
                }
            }
        }
        Err(_) => Vec::new(),
    }
}

/// Save the script list to app support dir (atomically — audit M4).
pub fn save_script_list(app_support: &Path, scripts: &[ScriptEntry]) -> Result<()> {
    let list_file = app_support.join("scripts.json");
    let content = serde_json::to_string_pretty(scripts)?;
    atomic_write(&list_file, &content)?;
    Ok(())
}

/// Load a script's state (last values, presets, history).
pub fn load_script_state(state_dir: &Path, script_id: &str) -> ScriptState {
    let file = state_dir.join(format!("{}.json", script_id));
    match std::fs::read_to_string(&file) {
        Ok(content) => {
            match serde_json::from_str::<ScriptState>(&content) {
                Ok(state) => state,
                Err(e) => {
                    tracing::error!("Failed to parse state for '{}' (corrupted?): {}", script_id, e);
                    ScriptState {
                        last_values: std::collections::HashMap::new(),
                        presets: vec![],
                        history: vec![],
                    }
                }
            }
        }
        Err(_) => ScriptState {
            last_values: std::collections::HashMap::new(),
            presets: vec![],
            history: vec![],
        },
    }
}

/// Save a script's state (atomically — audit M4).
pub fn save_script_state(state_dir: &Path, script_id: &str, state: &ScriptState) -> Result<()> {
    std::fs::create_dir_all(state_dir)?;
    let file = state_dir.join(format!("{}.json", script_id));
    let content = serde_json::to_string_pretty(state)?;
    atomic_write(&file, &content)?;
    Ok(())
}

/// Write to a temp file then atomically rename (audit M4).
/// Prevents data corruption if the process crashes mid-write.
pub(crate) fn atomic_write(target: &Path, content: &str) -> Result<()> {
    let tmp = target.with_extension("json.tmp");
    std::fs::write(&tmp, content)?;
    // fsync the temp file to ensure data is on disk before rename
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let file = std::fs::File::open(&tmp)?;
        let _ = unsafe { libc::fsync(file.as_raw_fd()) };
    }
    std::fs::rename(&tmp, target)?;
    Ok(())
}

/// Get the output directory for a specific run.
#[allow(dead_code)]
pub fn run_output_dir(output_dir: &Path, script_id: &str, job_id: &str) -> PathBuf {
    output_dir.join(script_id).join(job_id)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::model::{ScriptEntry, ScriptState, SchemaSource, Preset};
    use std::collections::HashMap;

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pyshell-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_entry(id: &str) -> ScriptEntry {
        ScriptEntry {
            id: id.to_string(),
            name: format!("Script {}", id),
            icon: None,
            category: None,
            needs: Vec::new(),
            path: PathBuf::from("/tmp/test.py"),
            source: SchemaSource::Yaml,
            reachable: true,
            schema_error: None,
        }
    }

    #[test]
    fn save_and_load_script_list() {
        let dir = tmp_dir();
        let scripts = vec![make_entry("a"), make_entry("b")];
        save_script_list(&dir, &scripts).unwrap();
        let loaded = load_script_list(&dir);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "a");
        assert_eq!(loaded[1].id, "b");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_script_list_missing_file_returns_empty() {
        let dir = tmp_dir();
        let loaded = load_script_list(&dir);
        assert!(loaded.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_script_list_corrupted_returns_empty() {
        let dir = tmp_dir();
        std::fs::write(dir.join("scripts.json"), "not json").unwrap();
        let loaded = load_script_list(&dir);
        assert!(loaded.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_and_load_script_state() {
        let dir = tmp_dir();
        let state = ScriptState {
            last_values: HashMap::from([("key".to_string(), serde_json::json!("value"))]),
            presets: vec![Preset {
                name: "test".to_string(),
                values: HashMap::new(),
            }],
            history: vec![],
        };
        save_script_state(&dir, "script1", &state).unwrap();
        let loaded = load_script_state(&dir, "script1");
        assert_eq!(loaded.last_values.get("key").unwrap(), &serde_json::json!("value"));
        assert_eq!(loaded.presets.len(), 1);
        assert_eq!(loaded.presets[0].name, "test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_script_state_missing_returns_default() {
        let dir = tmp_dir();
        let loaded = load_script_state(&dir, "nonexistent");
        assert!(loaded.last_values.is_empty());
        assert!(loaded.presets.is_empty());
        assert!(loaded.history.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_script_state_corrupted_returns_default() {
        let dir = tmp_dir();
        std::fs::write(dir.join("bad.json"), "garbage").unwrap();
        let loaded = load_script_state(&dir, "bad");
        assert!(loaded.last_values.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atomic_write_replaces_existing() {
        let dir = tmp_dir();
        let target = dir.join("test.json");
        std::fs::write(&target, "old").unwrap();
        atomic_write(&target, "new content").unwrap();
        let content = std::fs::read_to_string(&target).unwrap();
        assert_eq!(content, "new content");
        // No tmp file left behind
        assert!(!dir.join("test.json.tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_script_state_creates_dir() {
        let dir = tmp_dir();
        let nested = dir.join("nested");
        let state = ScriptState {
            last_values: HashMap::new(),
            presets: vec![],
            history: vec![],
        };
        save_script_state(&nested, "s1", &state).unwrap();
        assert!(nested.join("s1.json").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn run_output_dir_joins_correctly() {
        let path = run_output_dir(Path::new("/output"), "script1", "job1");
        assert_eq!(path, PathBuf::from("/output/script1/job1"));
    }
}
