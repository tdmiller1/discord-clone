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

/// On Linux, WebKitGTK ships with media capture turned off and denies the
/// `getUserMedia` permission request unless the embedder opts in. Without this the
/// voice channel sees "0 devices" even when the OS mic works fine. wry/Tauri do not
/// configure either, so we reach the underlying WebView and do it ourselves.
/// No-op on macOS/Windows, whose webviews grant capture via the OS prompt.
#[cfg(target_os = "linux")]
fn enable_webkit_media_capture(app: &tauri::App) {
    use tauri::Manager;
    use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(|webview| {
        let wv = webview.inner();
        if let Some(settings) = WebViewExt::settings(&wv) {
            settings.set_enable_media_stream(true);
            settings.set_enable_webrtc(true);
        }
        // The webview only ever loads our own bundle, so granting permission
        // requests (mic via UserMedia + enumerateDevices labels via DeviceInfo) is safe.
        wv.connect_permission_request(|_wv, req| {
            req.allow();
            true
        });
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Auto-update: `updater` checks the configured endpoint and installs signed
        // releases; `process` provides the `relaunch` the frontend calls afterwards.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|_app| {
            #[cfg(target_os = "linux")]
            enable_webkit_media_capture(_app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_session,
            get_session,
            delete_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
