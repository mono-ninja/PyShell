use std::path::Path;

use tauri::State;

use crate::error::{AppError, Result};
use crate::manifest::model::SecretEntry;
use crate::AppState;

const SERVICE_NAME: &str = "com.pyshell.app";

/// The registry of secrets PyShell has written (`secrets.json` in Application
/// Support).
///
/// The OS keychain cannot *enumerate* entries — its API is get/set/delete per
/// account — so this file is what makes "which secrets exist at all" answerable
/// (Settings ▸ Secrets). It is a hint, not a source of truth: every read is
/// reconciled against the keychain, entries declared by an installed schema but
/// missing from the registry are merged in (secrets set before the registry
/// existed), and entries whose value is gone are dropped.
///
/// Values never appear here — only `script_id`, `key` and when the value was
/// written.
const REGISTRY_FILE: &str = "secrets.json";

fn keyring_entry(script_id: &str, key: &str) -> std::result::Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(SERVICE_NAME, &format!("{}:{}", script_id, key))
}

fn registry_path(app_support: &Path) -> std::path::PathBuf {
    app_support.join(REGISTRY_FILE)
}

fn load_registry(app_support: &Path) -> Vec<SecretEntry> {
    match std::fs::read_to_string(registry_path(app_support)) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            tracing::error!("Failed to parse {} (corrupted?): {}", REGISTRY_FILE, e);
            Vec::new()
        }),
        Err(_) => Vec::new(),
    }
}

fn save_registry(app_support: &Path, entries: &[SecretEntry]) -> Result<()> {
    let content = serde_json::to_string_pretty(entries)?;
    crate::store::state::atomic_write(&registry_path(app_support), &content)
}

/// Record (or refresh the timestamp of) a secret in the registry. Best-effort:
/// a failed registry write must not fail the store that succeeded.
fn remember(app_support: &Path, entry: &SecretEntry) {
    let mut entries = load_registry(app_support);
    match entries
        .iter_mut()
        .find(|e| e.script_id == entry.script_id && e.key == entry.key)
    {
        Some(existing) => *existing = entry.clone(),
        None => entries.push(entry.clone()),
    }
    if let Err(e) = save_registry(app_support, &entries) {
        tracing::warn!("Failed to update {}: {}", REGISTRY_FILE, e);
    }
}

/// Drop a secret from the registry (its keychain value is handled separately).
fn forget_one(app_support: &Path, script_id: &str, key: &str) {
    let mut entries = load_registry(app_support);
    let before = entries.len();
    entries.retain(|e| !(e.script_id == script_id && e.key == key));
    if entries.len() != before {
        if let Err(e) = save_registry(app_support, &entries) {
            tracing::warn!("Failed to update {}: {}", REGISTRY_FILE, e);
        }
    }
}

/// Does the keychain currently hold this secret? `Err` means "cannot tell"
/// (locked keychain, access denied) — callers treat it as "keep", not as "gone".
fn keychain_has(script_id: &str, key: &str) -> std::result::Result<bool, keyring::Error> {
    let entry = keyring_entry(script_id, key)?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Store a secret in the system keychain (macOS Keychain / Windows Credential
/// Manager) and record it in the registry so Settings can list it.
#[tauri::command]
pub async fn set_secret(
    script_id: String,
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<()> {
    keyring_entry(&script_id, &key)
        .and_then(|e| e.set_password(&value))
        .map_err(|e| AppError::Secret(e.to_string()))?;
    remember(
        &state.app_support_dir,
        &SecretEntry {
            script_id,
            key,
            set_at: Some(chrono::Local::now().to_rfc3339()),
        },
    );
    Ok(())
}

/// Check if a secret exists in the keychain.
#[tauri::command]
pub async fn has_secret(script_id: String, key: String) -> Result<bool> {
    keychain_has(&script_id, &key).map_err(|e| AppError::Secret(e.to_string()))
}

/// Delete a secret from the keychain (and the registry).
#[tauri::command]
pub async fn delete_secret(
    script_id: String,
    key: String,
    state: State<'_, AppState>,
) -> Result<()> {
    keyring_entry(&script_id, &key)
        .and_then(|e| e.delete_credential())
        .map_err(|e| AppError::Secret(e.to_string()))?;
    forget_one(&state.app_support_dir, &script_id, &key);
    Ok(())
}

/// Every secret PyShell knows about, for Settings ▸ Secrets: registry entries
/// plus schema-declared secrets that predate the registry, reconciled against
/// the keychain so the list shows only what is actually stored.
///
/// Values are not part of the answer — they stay in the keychain.
#[tauri::command]
pub async fn secrets_list(state: State<'_, AppState>) -> Result<Vec<SecretEntry>> {
    // Schema-declared secrets per script, for the merge below.
    let scripts = state.scripts.lock().unwrap().clone();
    let mut declared: Vec<(String, Vec<String>)> = Vec::new();
    for script in &scripts {
        if let Ok(Some(schema)) = crate::commands::scripts::load_schema(&state, &script.id) {
            let keys = schema
                .inputs
                .iter()
                .filter(|i| matches!(i.r#type, crate::manifest::model::InputType::Secret))
                .map(|i| i.key.clone())
                .collect();
            declared.push((script.id.clone(), keys));
        }
    }

    let mut live = merge_declared(load_registry(&state.app_support_dir), &declared);

    // Reconcile with the keychain: drop entries whose value is provably gone
    // (deleted outside PyShell), keep the ones we cannot check.
    let mut out = Vec::with_capacity(live.len());
    for entry in live.drain(..) {
        match keychain_has(&entry.script_id, &entry.key) {
            Ok(true) => out.push(entry),
            Ok(false) => forget_one(&state.app_support_dir, &entry.script_id, &entry.key),
            Err(e) => {
                tracing::warn!(
                    "Cannot verify secret '{}:{}' (keychain access failed: {}) — keeping it in the list",
                    entry.script_id,
                    entry.key,
                    e
                );
                out.push(entry);
            }
        }
    }

    out.sort();
    out.dedup();
    Ok(out)
}

/// Merge schema-declared secret keys into a registry list: a declared key with
/// no registry entry appears with `set_at: None` (set before the registry
/// existed), a known one keeps its timestamp. Pure, so the merge itself is
/// testable without a keychain.
fn merge_declared(
    mut entries: Vec<SecretEntry>,
    declared: &[(String, Vec<String>)],
) -> Vec<SecretEntry> {
    for (script_id, keys) in declared {
        for key in keys {
            if !entries
                .iter()
                .any(|e| e.script_id == *script_id && e.key == *key)
            {
                entries.push(SecretEntry {
                    script_id: script_id.clone(),
                    key: key.clone(),
                    set_at: None,
                });
            }
        }
    }
    entries
}

/// Delete every keychain secret belonging to `script_id` — the script-removal
/// path (plan P1-1). Keys are collected from the registry *and* from the saved
/// schema's `InputType::Secret` inputs, so a schema edit between setting and
/// removing cannot orphan a value. Best-effort like the rest of the removal:
/// each failure is logged, none aborts it.
///
/// Duplicate scripts are safe by construction: their secrets live under their
/// own `script_id`, so removing a duplicate never touches the original's keys.
pub fn forget_script(state: &AppState, script_id: &str) {
    let mut keys: Vec<String> = load_registry(&state.app_support_dir)
        .into_iter()
        .filter(|e| e.script_id == script_id)
        .map(|e| e.key)
        .collect();

    if let Ok(Some(schema)) = crate::commands::scripts::load_schema(state, script_id) {
        for input in &schema.inputs {
            if matches!(input.r#type, crate::manifest::model::InputType::Secret)
                && !keys.contains(&input.key)
            {
                keys.push(input.key.clone());
            }
        }
    }

    for key in &keys {
        match keyring_entry(script_id, key).and_then(|e| e.delete_credential()) {
            Ok(()) => {}
            Err(keyring::Error::NoEntry) => {} // never set, or already gone
            Err(e) => tracing::warn!(
                "Failed to delete secret '{}:{}' from the keychain: {}",
                script_id,
                key,
                e
            ),
        }
    }

    let mut entries = load_registry(&state.app_support_dir);
    let before = entries.len();
    entries.retain(|e| e.script_id != script_id);
    if entries.len() != before {
        if let Err(e) = save_registry(&state.app_support_dir, &entries) {
            tracing::warn!("Failed to update {}: {}", REGISTRY_FILE, e);
        }
    }

    if !keys.is_empty() {
        tracing::info!(
            "Removed {} keychain secret(s) of script '{}'",
            keys.len(),
            script_id
        );
    }
}

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

    fn entry(script_id: &str, key: &str) -> SecretEntry {
        SecretEntry {
            script_id: script_id.to_string(),
            key: key.to_string(),
            set_at: None,
        }
    }

    #[test]
    fn remember_is_idempotent_per_script_and_key() {
        let dir = tmp_dir();
        remember(&dir, &entry("s1", "api_key"));
        remember(&dir, &entry("s1", "api_key"));
        remember(&dir, &entry("s1", "other"));
        remember(&dir, &entry("s2", "api_key"));

        let entries = load_registry(&dir);
        assert_eq!(entries.len(), 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn forget_one_removes_only_that_entry() {
        let dir = tmp_dir();
        remember(&dir, &entry("s1", "a"));
        remember(&dir, &entry("s1", "b"));
        remember(&dir, &entry("s2", "a"));

        forget_one(&dir, "s1", "a");
        let entries = load_registry(&dir);
        assert_eq!(entries.len(), 2);
        assert!(!entries.iter().any(|e| e.script_id == "s1" && e.key == "a"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_corrupted_registry_loads_empty() {
        let dir = tmp_dir();
        std::fs::write(registry_path(&dir), "not json").unwrap();
        assert!(load_registry(&dir).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The merge step of `secrets_list`, pure: schema-declared secrets that
    /// are missing from the registry appear with `set_at: None`, known ones
    /// keep their timestamp.
    #[test]
    fn merge_declared_fills_gaps_without_touching_known_entries() {
        let dir = tmp_dir();
        remember(
            &dir,
            &SecretEntry {
                script_id: "s1".into(),
                key: "known".into(),
                set_at: Some("2026-01-01T00:00:00+02:00".into()),
            },
        );
        let registry = load_registry(&dir);

        let merged = merge_declared(
            registry,
            &[("s1".to_string(), vec!["known".into(), "legacy".into()])],
        );

        assert_eq!(merged.len(), 2);
        assert_eq!(
            merged.iter().find(|e| e.key == "known").unwrap().set_at,
            Some("2026-01-01T00:00:00+02:00".into())
        );
        assert_eq!(merged.iter().find(|e| e.key == "legacy").unwrap().set_at, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn merge_declared_does_not_touch_other_scripts() {
        let merged = merge_declared(
            vec![entry("s1", "api_key")],
            &[("s2".to_string(), vec!["api_key".into()])],
        );
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().any(|e| e.script_id == "s1" && e.key == "api_key"));
        assert!(merged.iter().any(|e| e.script_id == "s2" && e.key == "api_key"));
    }
}
