//! Pinned scripts: the sidebar's Favorites section and ⌘1…⌘9.

use tauri::{AppHandle, State};

use crate::error::Result;
use crate::{menu, store, AppState};

/// Ids of the pinned scripts, in shortcut order.
///
/// Also re-syncs the native menu, because this is called after every script
/// list refresh — which is exactly when a pinned script may have been renamed
/// by a manifest edit, and the menu item still says the old name.
#[tauri::command]
pub async fn list_favorites(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<String>> {
    let ids = store::favorites::load(&state.app_support_dir, &known_ids(&state));
    sync_menu(&app, &state, &ids);
    Ok(ids)
}

/// Pin or unpin one script; returns the new order.
#[tauri::command]
pub async fn toggle_favorite(
    script_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>> {
    let ids = store::favorites::toggle(&state.app_support_dir, &known_ids(&state), &script_id)?;
    sync_menu(&app, &state, &ids);
    Ok(ids)
}

fn known_ids(state: &AppState) -> Vec<String> {
    state
        .scripts
        .lock()
        .unwrap()
        .iter()
        .map(|s| s.id.clone())
        .collect()
}

/// Rebuild the menu so its Favorites submenu matches `ids`.
///
/// Rebuilding replaces the whole menu bar, so it is skipped unless the ids or
/// the names actually changed — otherwise every script list refresh would swap
/// the menu out from under an open menu.
pub fn sync_menu(app: &AppHandle, state: &AppState, ids: &[String]) {
    let items = label_favorites(state, ids);
    {
        let current = state.menu_favorites.lock().unwrap();
        if *current == items {
            return;
        }
    }
    match menu::build(app, &items) {
        Ok(rebuilt) => {
            if let Err(e) = app.set_menu(rebuilt) {
                tracing::error!("failed to install rebuilt menu: {e}");
                return;
            }
            *state.menu_favorites.lock().unwrap() = items;
        }
        Err(e) => tracing::error!("failed to rebuild menu for favorites: {e}"),
    }
}

/// Pair each pinned id with the script's current name, dropping ids whose
/// script is gone (the sidebar prunes the same way).
pub fn label_favorites(state: &AppState, ids: &[String]) -> Vec<menu::Favorite> {
    let scripts = state.scripts.lock().unwrap();
    ids.iter()
        .filter_map(|id| {
            scripts
                .iter()
                .find(|s| &s.id == id)
                .map(|s| (id.clone(), s.name.clone()))
        })
        .collect()
}
