use std::collections::HashMap;

use tauri::State;

use crate::error::Result;
use crate::manifest::model::ScriptState;
use crate::store;
use crate::AppState;

/// Get the saved state for a script (last values, presets, history).
#[tauri::command]
pub async fn get_state(script_id: String, state: State<'_, AppState>) -> Result<ScriptState> {
    Ok(store::state::load_script_state(&state.state_dir(), &script_id))
}

/// Save a named preset for a script.
#[tauri::command]
pub async fn save_preset(
    script_id: String,
    name: String,
    values: HashMap<String, serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<()> {
    let mut current = store::state::load_script_state(&state.state_dir(), &script_id);
    current.presets.retain(|p| p.name != name);
    current.presets.push(crate::manifest::model::Preset {
        name,
        values,
    });
    store::state::save_script_state(&state.state_dir(), &script_id, &current)
}

/// Delete a named preset. Returns true if a preset was removed.
#[tauri::command]
pub async fn delete_preset(
    script_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<bool> {
    let mut current = store::state::load_script_state(&state.state_dir(), &script_id);
    let before = current.presets.len();
    current.presets.retain(|p| p.name != name);
    let removed = current.presets.len() != before;
    if removed {
        store::state::save_script_state(&state.state_dir(), &script_id, &current)?;
    }
    Ok(removed)
}

/// Rename a preset. Fails if `new_name` already exists or `old_name` is absent.
#[tauri::command]
pub async fn rename_preset(
    script_id: String,
    old_name: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let new_name = new_name.trim().to_string();
    if new_name.is_empty() {
        return Err(crate::error::AppError::Other("preset name cannot be empty".to_string()));
    }
    let mut current = store::state::load_script_state(&state.state_dir(), &script_id);
    if current.presets.iter().any(|p| p.name == new_name) {
        return Err(crate::error::AppError::Other(format!(
            "a preset named '{}' already exists", new_name
        )));
    }
    let Some(preset) = current.presets.iter_mut().find(|p| p.name == old_name) else {
        return Err(crate::error::AppError::Other(format!(
            "preset '{}' not found", old_name
        )));
    };
    preset.name = new_name;
    store::state::save_script_state(&state.state_dir(), &script_id, &current)
}

/// Save the last used form values for a script.
#[tauri::command]
pub async fn save_last_values(
    script_id: String,
    values: HashMap<String, serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<()> {
    let mut current = store::state::load_script_state(&state.state_dir(), &script_id);
    current.last_values = values;
    store::state::save_script_state(&state.state_dir(), &script_id, &current)
}

/// Merge imported presets into a script's state (Plan.md §2.6).
/// Existing presets with the same name are overwritten.
#[tauri::command]
pub async fn import_presets(
    script_id: String,
    presets: Vec<crate::manifest::model::Preset>,
    state: State<'_, AppState>,
) -> Result<()> {
    let mut current = store::state::load_script_state(&state.state_dir(), &script_id);
    for preset in presets {
        current.presets.retain(|p| p.name != preset.name);
        current.presets.push(preset);
    }
    store::state::save_script_state(&state.state_dir(), &script_id, &current)
}
