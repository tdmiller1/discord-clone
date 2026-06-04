use keyring::{Entry, Error as KeyringError};

const KEYCHAIN_SERVICE: &str = "discord-clone";
const KEYCHAIN_ACCOUNT: &str = "session";

fn entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

/// Store the opaque session token in the OS keychain (overwrites any existing).
#[tauri::command]
fn set_session(token: String) -> Result<(), String> {
    entry()?.set_password(&token).map_err(|e| e.to_string())
}

/// Read the stored session token; `None` when no entry exists.
#[tauri::command]
fn get_session() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Remove the stored session token; succeeds even if absent (idempotent).
#[tauri::command]
fn delete_session() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            set_session,
            get_session,
            delete_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
