//! Pinned scripts, in the order the user pinned them.
//!
//! Kept as an ordered list rather than a `favorite: bool` on `ScriptEntry`
//! because the position *is* the shortcut: the first nine entries are ⌘1…⌘9,
//! and a flag would leave that order at the mercy of import order and the
//! sidebar's A→Z toggle — the numbers would move under the user.
//!
//! Lives in Application Support with the rest of the user state, not in the
//! webview's localStorage: it survives a cleared webview, and `remove_script`
//! can prune it along with everything else it owns.

use std::path::Path;

use crate::error::Result;

/// Favorites that still resolve to an imported script, order preserved.
///
/// Stale ids are dropped rather than kept as holes: a favorite pointing at a
/// removed script would silently shift every shortcut after it.
pub fn load(app_support: &Path, known_ids: &[String]) -> Vec<String> {
    let raw: Vec<String> = match std::fs::read_to_string(app_support.join("favorites.json")) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            tracing::error!("Failed to parse favorites.json (corrupted?): {}", e);
            Vec::new()
        }),
        Err(_) => Vec::new(),
    };
    raw.into_iter().filter(|id| known_ids.contains(id)).collect()
}

pub fn save(app_support: &Path, ids: &[String]) -> Result<()> {
    let content = serde_json::to_string_pretty(ids)?;
    super::state::atomic_write(&app_support.join("favorites.json"), &content)
}

/// Pin or unpin one script. Pinning appends, so existing shortcuts keep their
/// numbers; unpinning closes the gap.
pub fn toggle(app_support: &Path, known_ids: &[String], script_id: &str) -> Result<Vec<String>> {
    let mut ids = load(app_support, known_ids);
    if let Some(at) = ids.iter().position(|id| id == script_id) {
        ids.remove(at);
    } else {
        ids.push(script_id.to_string());
    }
    save(app_support, &ids)?;
    Ok(ids)
}

/// Drop one id (used when a script is removed).
pub fn forget(app_support: &Path, script_id: &str) {
    let path = app_support.join("favorites.json");
    if !path.exists() {
        return;
    }
    let mut ids: Vec<String> = match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => return,
    };
    if ids.iter().any(|id| id == script_id) {
        ids.retain(|id| id != script_id);
        if let Err(e) = save(app_support, &ids) {
            tracing::warn!("Failed to prune favorites for '{}': {}", script_id, e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn toggle_appends_then_removes() {
        let dir = std::env::temp_dir().join(format!("pyshell-fav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let known = ids(&["a", "b", "c"]);

        assert_eq!(toggle(&dir, &known, "b").unwrap(), ids(&["b"]));
        assert_eq!(toggle(&dir, &known, "a").unwrap(), ids(&["b", "a"]));
        // Pinning is append-only, so "b" keeps ⌘1 when "a" joins.
        assert_eq!(load(&dir, &known), ids(&["b", "a"]));

        assert_eq!(toggle(&dir, &known, "b").unwrap(), ids(&["a"]));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_drops_ids_that_are_no_longer_imported() {
        let dir = std::env::temp_dir().join(format!("pyshell-fav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        save(&dir, &ids(&["gone", "kept"])).unwrap();

        assert_eq!(load(&dir, &ids(&["kept"])), ids(&["kept"]));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn forget_rewrites_only_when_the_id_was_pinned() {
        let dir = std::env::temp_dir().join(format!("pyshell-fav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let known = ids(&["a", "b"]);
        save(&dir, &known).unwrap();

        forget(&dir, "a");
        assert_eq!(load(&dir, &known), ids(&["b"]));
        // Unknown id: no-op, not a panic and not a truncated file.
        forget(&dir, "never-pinned");
        assert_eq!(load(&dir, &known), ids(&["b"]));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_and_corrupt_files_read_as_empty() {
        let dir = std::env::temp_dir().join(format!("pyshell-fav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load(&dir, &ids(&["a"])).is_empty());

        std::fs::write(dir.join("favorites.json"), "{ not a list").unwrap();
        assert!(load(&dir, &ids(&["a"])).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
