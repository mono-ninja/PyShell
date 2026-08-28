use crate::error::{AppError, Result};

const SERVICE_NAME: &str = "com.pyshell.app";

/// Store a secret in the system keychain (macOS Keychain / Windows Credential Manager).
#[tauri::command]
pub async fn set_secret(script_id: String, key: String, value: String) -> Result<()> {
    let entry = keyring::Entry::new(SERVICE_NAME, &format!("{}:{}", script_id, key))
        .map_err(|e| AppError::Secret(e.to_string()))?;
    entry
        .set_password(&value)
        .map_err(|e| AppError::Secret(e.to_string()))?;
    Ok(())
}

/// Check if a secret exists in the keychain.
#[tauri::command]
pub async fn has_secret(script_id: String, key: String) -> Result<bool> {
    let entry = keyring::Entry::new(SERVICE_NAME, &format!("{}:{}", script_id, key))
        .map_err(|e| AppError::Secret(e.to_string()))?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(AppError::Secret(format!("keychain access failed: {}", e))),
    }
}

/// Delete a secret from the keychain.
#[tauri::command]
pub async fn delete_secret(script_id: String, key: String) -> Result<()> {
    let entry = keyring::Entry::new(SERVICE_NAME, &format!("{}:{}", script_id, key))
        .map_err(|e| AppError::Secret(e.to_string()))?;
    entry
        .delete_credential()
        .map_err(|e| AppError::Secret(e.to_string()))?;
    Ok(())
}
