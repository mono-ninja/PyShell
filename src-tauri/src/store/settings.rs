use std::path::Path;

use crate::error::Result;
use crate::manifest::model::AppSettings;

/// Lower bound for `retention_runs`. Zero would keep no run at all — the
/// History tab and the Log/Files buttons would be dead on arrival.
pub const MIN_RETENTION_RUNS: usize = 1;

/// Upper bound for `retention_runs`. Each kept run is a folder on disk with a
/// full log; six digits of them per script is a disk problem, not a feature.
pub const MAX_RETENTION_RUNS: usize = 500;

/// Bring a deserialized/settings value into the allowed range.
pub fn sanitize(settings: &mut AppSettings) {
    settings.retention_runs = settings
        .retention_runs
        .clamp(MIN_RETENTION_RUNS, MAX_RETENTION_RUNS);
}

/// Load the app-wide settings. Missing file, corrupted file and missing fields
/// all fall back field-by-field to [`AppSettings::default`] — settings must
/// never be the reason the app refuses to run.
pub fn load(app_support: &Path) -> AppSettings {
    let file = app_support.join("settings.json");
    let mut settings = match std::fs::read_to_string(&file) {
        Ok(content) => serde_json::from_str::<AppSettings>(&content).unwrap_or_else(|e| {
            tracing::error!("Failed to parse settings.json (corrupted?): {} — using defaults", e);
            AppSettings::default()
        }),
        Err(_) => AppSettings::default(),
    };
    sanitize(&mut settings);
    settings
}

/// Save the app-wide settings (atomically, like every state file).
pub fn save(app_support: &Path, settings: &AppSettings) -> Result<()> {
    let mut settings = settings.clone();
    sanitize(&mut settings);
    let file = app_support.join("settings.json");
    let content = serde_json::to_string_pretty(&settings)?;
    super::state::atomic_write(&file, &content)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pyshell-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_loads_defaults() {
        let dir = tmp_dir();
        assert_eq!(load(&dir), AppSettings::default());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupted_file_loads_defaults() {
        let dir = tmp_dir();
        std::fs::write(dir.join("settings.json"), "not json").unwrap();
        assert_eq!(load(&dir), AppSettings::default());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tmp_dir();
        save(&dir, &AppSettings { retention_runs: 20 }).unwrap();
        assert_eq!(load(&dir).retention_runs, 20);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_clamps_out_of_range_values() {
        let dir = tmp_dir();
        save(&dir, &AppSettings { retention_runs: 0 }).unwrap();
        assert_eq!(load(&dir).retention_runs, MIN_RETENTION_RUNS);

        save(&dir, &AppSettings { retention_runs: 100_000 }).unwrap();
        assert_eq!(load(&dir).retention_runs, MAX_RETENTION_RUNS);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_file_missing_the_field_falls_back_to_the_field_default() {
        // Forward/backward compatibility: a settings.json written by a version
        // without `retention_runs` (or with extra fields) still loads.
        let dir = tmp_dir();
        std::fs::write(dir.join("settings.json"), "{}").unwrap();
        assert_eq!(load(&dir).retention_runs, AppSettings::default().retention_runs);
        std::fs::remove_dir_all(&dir).ok();
    }
}
