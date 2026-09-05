use tauri::State;

use crate::error::Result;
use crate::manifest::model::AppSettings;
use crate::store;
use crate::AppState;

/// The app-wide settings (see [`AppSettings`]).
#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings> {
    Ok(store::settings::load(&state.app_support_dir))
}

/// Persist the app-wide settings. Values are sanitized (clamped to the allowed
/// range) before saving, and the sanitized result is returned so the UI can
/// show what actually stuck rather than what was typed.
#[tauri::command]
pub async fn set_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<AppSettings> {
    store::settings::save(&state.app_support_dir, &settings)?;
    Ok(store::settings::load(&state.app_support_dir))
}
