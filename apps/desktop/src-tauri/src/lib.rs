//! ARTÉPOOL ERP for Windows (Tauri 2). The screens are the web part (apps/desktop/src); every
//! call to the Main Server goes through the commands below, into `artepool-bridge`: TLS 1.3,
//! only the pinned ARTÉPOOL CA, and the device key kept in Windows Credential Manager. The
//! screens never see the key and cannot open a connection themselves (see tauri.conf.json CSP).

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use artepool_bridge::loopback::{Callback, Loopback, is_google_sign_in};
use artepool_bridge::rules::{KioskView, kiosk_view};
use artepool_bridge::{
    Bridge, BridgeRequest, BridgeResponse, EnrollInput, EnrollOutcome, LocalDevice,
};
use tauri::{Emitter as _, Manager as _};

#[cfg(windows)]
type Store = artepool_bridge::store::CredentialStore;
#[cfg(not(windows))]
type Store = artepool_bridge::store::FileStore;

struct AppBridge(Bridge<Store>);

/// Whether this window is held in POS kiosk mode now (decisions 0082, 0089).
struct Kiosk(AtomicBool);

/// The listener waiting for Google's answer while the owner connects Google Drive (0095).
struct GoogleSignIn(Mutex<Option<Loopback>>);

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

/// Kiosk mode: full screen, no title bar or window buttons, and closing is refused (see
/// `run`). Lifted, the window is a normal window that may be minimised or closed.
fn apply_kiosk(app: &tauri::AppHandle, locked: bool) {
    app.state::<Kiosk>().0.store(locked, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_decorations(!locked);
        let _ = window.set_fullscreen(locked);
        let _ = window.set_closable(!locked);
        let _ = window.set_minimizable(!locked);
        if locked {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

/// How often this PC asks the server for its kiosk lock on its own (decision 0089).
const KIOSK_POLL: std::time::Duration = std::time::Duration::from_secs(5);

/// Asks the server for this PC's kiosk lock and applies it. The answer is read here, never
/// taken from the screens, and it fails closed: a POS PC that cannot reach the server stays
/// locked (decision 0089).
async fn refresh_kiosk(app: &tauri::AppHandle) -> Result<KioskView, String> {
    let state = app.state::<AppBridge>();
    let local = state.0.local_device().map_err(|e| e.to_string())?;
    let kind = local.device.as_ref().map(|d| d.kind.as_str());
    let answer = state
        .0
        .request(BridgeRequest {
            method: "GET".into(),
            path: "/api/v1/kiosk/state".into(),
            body: None,
            token: None,
            idempotency_key: None,
            background: Some(true),
        })
        .await;
    let view = match &answer {
        Ok(BridgeResponse::Response { status, body, .. }) => {
            kiosk_view(kind, Some(*status), Some(body))
        }
        _ => kiosk_view(kind, None, None),
    };
    apply_kiosk(app, view.locked);
    Ok(view)
}

/// The screens ask right after an owner-code unlock, so the window changes at once.
#[tauri::command]
async fn kiosk_refresh(app: tauri::AppHandle) -> Result<KioskView, String> {
    refresh_kiosk(&app).await
}

/// Connecting Google Drive (decision 0095), step 1: a one-time listener on this PC; its port
/// goes into the address Google sends the answer to.
#[tauri::command]
fn google_signin_start(state: tauri::State<'_, GoogleSignIn>) -> Result<u16, String> {
    let loopback = Loopback::bind().map_err(|e| e.to_string())?;
    let port = loopback.port();
    *state.0.lock().map_err(|_| "busy".to_string())? = Some(loopback);
    Ok(port)
}

/// Step 2: Google's page in the PC's own browser (only Google's sign-in page may be opened).
#[tauri::command]
fn google_signin_open(url: String) -> Result<(), String> {
    if !is_google_sign_in(&url) {
        return Err("Only Google's sign-in page can be opened".into());
    }
    #[cfg(windows)]
    let mut command = {
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", &url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Step 3: waits (at most 5 minutes) for Google's one-time code and returns it to the screens,
/// which pass it to the server; the listener then closes.
#[tauri::command]
async fn google_signin_wait(state: tauri::State<'_, GoogleSignIn>) -> Result<Callback, String> {
    let loopback = state
        .0
        .lock()
        .map_err(|_| "busy".to_string())?
        .take()
        .ok_or_else(|| "No Google sign-in in progress".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        loopback.wait(std::time::Duration::from_secs(5 * 60))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
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
async fn printer_print(
    printer: String,
    document_name: String,
    data_base64: String,
) -> Result<(), String> {
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

/// Prints a receipt image (1 bit per dot, base64) through the printer's own Windows driver,
/// silently: for printers that do not take ESC/POS bytes (decision 0070).
#[tauri::command]
async fn printer_print_image(
    printer: String,
    document_name: String,
    width_dots: u32,
    height: u32,
    bits_base64: String,
) -> Result<(), String> {
    use base64::Engine as _;
    let bits = base64::engine::general_purpose::STANDARD
        .decode(bits_base64.as_bytes())
        .map_err(|_| "The print job is not valid".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let image = artepool_printer::ReceiptBitmap {
            width_dots,
            height,
            bits: &bits,
        };
        artepool_printer::send_image(&printer, &document_name, &image)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Prints barcode labels (an image at the label printer's dots, base64) through the printer's own
/// Windows driver at the label's exact size, one page per label, silently (decision 0096).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn printer_print_label(
    printer: String,
    document_name: String,
    width_dots: u32,
    height: u32,
    bits_base64: String,
    dpi: u32,
    width_mm10: u32,
    height_mm10: u32,
    copies: u32,
) -> Result<(), String> {
    use base64::Engine as _;
    let bits = base64::engine::general_purpose::STANDARD
        .decode(bits_base64.as_bytes())
        .map_err(|_| "The print job is not valid".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let job = artepool_printer::LabelJob {
            bitmap: artepool_printer::ReceiptBitmap {
                width_dots,
                height,
                bits: &bits,
            },
            dpi,
            width_mm10,
            height_mm10,
            copies,
        };
        artepool_printer::send_label(&printer, &document_name, &job)
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
            // A PC enrolled as POS starts locked, before the server has even answered.
            let pos = bridge
                .local_device()
                .ok()
                .and_then(|d| d.device)
                .is_some_and(|d| d.kind == "pos");
            app.manage(AppBridge(bridge));
            app.manage(Kiosk(AtomicBool::new(false)));
            app.manage(GoogleSignIn(Mutex::new(None)));
            apply_kiosk(app.handle(), pos);
            // Checked here every few seconds as well, whatever the screens do: a timed "off"
            // ends on time even if the screens stop asking.
            // Office PCs are not asked (the screens ask when the server says the PC is a POS).
            if pos {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        let _ = refresh_kiosk(&handle).await;
                        tokio::time::sleep(KIOSK_POLL).await;
                    }
                });
            }
            Ok(())
        })
        // Closing from inside the app (Alt+F4, the close message) is refused while locked; the
        // screens report it to the server, which alerts the owner (decision 0082).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window
                    .app_handle()
                    .state::<Kiosk>()
                    .0
                    .load(Ordering::SeqCst)
                {
                    api.prevent_close();
                    let _ = window.emit("kiosk-close-refused", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            bridge_local_device,
            bridge_enroll,
            bridge_request,
            kiosk_refresh,
            google_signin_start,
            google_signin_open,
            google_signin_wait,
            printer_list,
            printer_print,
            printer_print_image,
            printer_print_label
        ])
        .run(tauri::generate_context!())
        .expect("ARTÉPOOL ERP could not start");
}
