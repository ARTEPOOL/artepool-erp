//! ARTÉPOOL ERP for Windows (Tauri 2). The screens are the web part (apps/desktop/src); every
//! call to the Main Server goes through the commands below, into `artepool-bridge`: TLS 1.3,
//! only the pinned ARTÉPOOL CA, and the device key kept in Windows Credential Manager. The
//! screens never see the key and cannot open a connection themselves (see tauri.conf.json CSP).

use artepool_bridge::{
    Bridge, BridgeRequest, BridgeResponse, EnrollInput, EnrollOutcome, LocalDevice,
};
use tauri::Manager as _;

#[cfg(windows)]
type Store = artepool_bridge::store::CredentialStore;
#[cfg(not(windows))]
type Store = artepool_bridge::store::FileStore;

struct AppBridge(Bridge<Store>);

/// The Windows computer name, suggested as the device code when enrolling.
fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default()
}

fn open_store(app: &tauri::AppHandle) -> Result<Store, String> {
    #[cfg(windows)]
    {
        let _ = app;
        artepool_bridge::store::CredentialStore::new("ARTEPOOL ERP", "device")
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        // Development builds on other systems only: a file readable by its owner only.
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        Ok(artepool_bridge::store::FileStore::new(
            dir.join("device.json"),
        ))
    }
}

#[tauri::command]
fn bridge_local_device(state: tauri::State<'_, AppBridge>) -> Result<LocalDevice, String> {
    state.0.local_device().map_err(|e| e.to_string())
}

#[tauri::command]
async fn bridge_enroll(
    state: tauri::State<'_, AppBridge>,
    input: EnrollInput,
) -> Result<EnrollOutcome, String> {
    state.0.enroll(input).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn bridge_request(
    state: tauri::State<'_, AppBridge>,
    request: BridgeRequest,
) -> Result<BridgeResponse, String> {
    state.0.request(request).await.map_err(|e| e.to_string())
}

/// The printers of this PC, for choosing the receipt printer (Settings → Devices).
#[tauri::command]
async fn printer_list() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(artepool_printer::list_printers)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Sends a receipt (ESC/POS bytes made by the screens, base64) RAW to the chosen printer:
/// silent, no dialog (decisions 0008, 0055).
#[tauri::command]
async fn printer_print(printer: String, document_name: String, data_base64: String) -> Result<(), String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|_| "The print job is not valid".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        artepool_printer::send_raw(&printer, &document_name, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // One copy per PC: starting it again brings the open window to the front.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // Updates install only with a valid signature from the ARTÉPOOL key (created in M6;
        // until then the public key is empty, so no update can ever be accepted).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let store = open_store(app.handle())?;
            let bridge = Bridge::new(store, env!("CARGO_PKG_VERSION"), computer_name());
            app.manage(AppBridge(bridge));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge_local_device,
            bridge_enroll,
            bridge_request,
            printer_list,
            printer_print
        ])
        .run(tauri::generate_context!())
        .expect("ARTÉPOOL ERP could not start");
}
