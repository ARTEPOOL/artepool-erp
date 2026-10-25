//! ARTÉPOOL ERP for Windows (Tauri 2). The screens are the web part (apps/desktop/src); every
//! call to the Main Server goes through the commands below, into `artepool-bridge`: TLS 1.3,
//! only the pinned ARTÉPOOL CA, and the device key kept in Windows Credential Manager. The
//! screens never see the key and cannot open a connection themselves (see tauri.conf.json CSP).

mod autostart;

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

/// The installer's files on the server PC (decision 0102): `C:\ProgramData\ARTEPOOL`.
fn setup_access() -> Option<artepool_bridge::setup::SetupAccess> {
    let base = std::env::var_os("ProgramData")?;
    artepool_bridge::setup::SetupAccess::from_data_dir(
        &std::path::Path::new(&base).join("ARTEPOOL"),
    )
}

/// This PC's Windows build (decision 0106: Windows 10 gets a warning in the setup screen).
#[cfg(windows)]
fn windows_build() -> Option<u32> {
    #[repr(C)]
    struct OsVersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        // Unlike GetVersionEx, it reports the real version whatever the app's manifest says.
        fn RtlGetVersion(info: *mut OsVersionInfo) -> i32;
    }
    let mut info = OsVersionInfo {
        size: std::mem::size_of::<OsVersionInfo>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service_pack: [0; 128],
    };
    (unsafe { RtlGetVersion(&mut info) } == 0).then_some(info.build)
}

#[cfg(not(windows))]
fn windows_build() -> Option<u32> {
    None
}

#[tauri::command]
fn setup_info() -> artepool_bridge::setup::SetupInfo {
    artepool_bridge::setup::SetupAccess::info(setup_access().as_ref(), windows_build())
}

#[tauri::command]
async fn setup_request(
    app: tauri::AppHandle,
    request: artepool_bridge::setup::SetupRequest,
) -> Result<BridgeResponse, String> {
    let Some(access) = setup_access() else {
        return Ok(BridgeResponse::Unreachable);
    };
    let version = app.package_info().version.to_string();
    artepool_bridge::setup::setup_request(&access, request, &version)
        .await
        .map_err(|e| e.to_string())
}

/// Where the restore looks for backup copies (decision 0102): USB drives, the person's Downloads,
/// Desktop and Documents, and this PC's local backups folder.
fn restore_places() -> Vec<(std::path::PathBuf, artepool_bridge::restore::Place)> {
    use artepool_bridge::restore::Place;
    use std::path::PathBuf;
    let mut places = removable_drives()
        .into_iter()
        .map(|drive| (drive, Place::Removable))
        .collect::<Vec<_>>();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let home = PathBuf::from(home);
        places.push((home.join("Downloads"), Place::Downloads));
        places.push((home.join("Desktop"), Place::Desktop));
        places.push((home.join("Documents"), Place::Documents));
    }
    if let Some(data) = std::env::var_os("ProgramData") {
        places.push((
            PathBuf::from(data).join("ARTEPOOL").join("backups"),
            Place::Backups,
        ));
    }
    places
}

/// The roots of the USB drives and memory cards plugged in now.
#[cfg(windows)]
fn removable_drives() -> Vec<std::path::PathBuf> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLogicalDrives() -> u32;
        fn GetDriveTypeW(root: *const u16) -> u32;
    }
    const DRIVE_REMOVABLE: u32 = 2;
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .filter_map(|i| {
            let root = format!("{}:\\", char::from(b'A' + i));
            let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
            (unsafe { GetDriveTypeW(wide.as_ptr()) } == DRIVE_REMOVABLE)
                .then(|| std::path::PathBuf::from(root))
        })
        .collect()
}

#[cfg(not(windows))]
fn removable_drives() -> Vec<std::path::PathBuf> {
    Vec::new()
}

/// The launcher the installer puts in `C:\Program Files\ARTEPOOL` (M6.2 part F).
fn restore_launcher() -> std::path::PathBuf {
    let base = std::env::var_os("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".into());
    std::path::Path::new(&base)
        .join("ARTEPOOL")
        .join("artepool-svc.exe")
}

/// The copies in the usual places, or the one file whose full path the person typed. Only while
/// the setup token is on this PC (right after installation, administrators only).
#[tauri::command]
fn restore_copies(path: Option<String>) -> Vec<artepool_bridge::restore::RestoreCopy> {
    use artepool_bridge::restore::{Place, copy_at, find_copies};
    if setup_access().is_none() {
        return Vec::new();
    }
    match path {
        Some(path) => copy_at(std::path::Path::new(path.trim()), Place::Typed)
            .into_iter()
            .collect(),
        None => find_copies(&restore_places()),
    }
}

#[tauri::command]
fn restore_start(
    state: tauri::State<'_, artepool_bridge::restore::RestoreRun>,
    request: artepool_bridge::restore::RestoreStart,
) -> Result<(), String> {
    if setup_access().is_none() {
        return Err("unavailable".into());
    }
    state
        .start(&restore_launcher(), &request)
        .map_err(str::to_string)
}

#[tauri::command]
fn restore_status(
    state: tauri::State<'_, artepool_bridge::restore::RestoreRun>,
) -> artepool_bridge::restore::RestoreStatus {
    state.status()
}

/// Started as "ARTÉPOOL – Emergency tool" (decision 0107): `artepool-emergency.exe`, which asks
/// for administrator rights, starts the app with `--emergency`.
fn emergency_mode() -> bool {
    std::env::args().skip(1).any(|arg| arg == "--emergency")
}

/// The installation on the server PC: `C:\Program Files\ARTEPOOL` and `C:\ProgramData\ARTEPOOL`.
fn installation() -> artepool_bridge::emergency::Installation {
    let programs = std::env::var_os("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".into());
    let data = std::env::var_os("ProgramData").unwrap_or_else(|| "C:\\ProgramData".into());
    artepool_bridge::emergency::Installation {
        program_dir: std::path::Path::new(&programs).join("ARTEPOOL"),
        data_dir: std::path::Path::new(&data).join("ARTEPOOL"),
    }
}

/// The server PC's app is updated by the server setup (with the server, at a safe time), never
/// by itself; every other PC updates itself from the public update list.
fn updates_itself() -> bool {
    !installation().launcher().is_file()
}

async fn pending_update(
    app: &tauri::AppHandle,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    use tauri_plugin_updater::UpdaterExt;
    if !updates_itself() {
        return Ok(None);
    }
    // No update key or list in this build (development, CI): nothing to check.
    let updater = app.updater().map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

/// A newer version of this app for this PC (decision 0108), with its release notes, or null.
#[tauri::command]
async fn app_update_check(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    Ok(match pending_update(&app).await? {
        Some(update) => serde_json::json!({
            "version": update.version,
            "notesAr": update.raw_json.get("notesAr"),
            "notesEn": update.raw_json.get("notesEn").cloned().or_else(|| update.body.clone().map(serde_json::Value::from)),
        }),
        None => serde_json::Value::Null,
    })
}

/// Downloads the signed setup (the updater checks its signature with the update key), runs it
/// and starts the new version.
#[tauri::command]
async fn app_update_install(app: tauri::AppHandle) -> Result<(), String> {
    let Some(update) = pending_update(&app).await? else {
        return Ok(());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

#[tauri::command]
fn emergency_info() -> serde_json::Value {
    let emergency = emergency_mode();
    serde_json::json!({
        "emergency": emergency,
        "serverPc": emergency && installation().is_server_pc(),
    })
}

/// The installation of the emergency window, or why it cannot act on this PC.
fn emergency_installation() -> Result<artepool_bridge::emergency::Installation, String> {
    let installation = installation();
    if emergency_mode() && installation.is_server_pc() {
        Ok(installation)
    } else {
        Err("not_server_pc".into())
    }
}

#[tauri::command]
async fn emergency_check() -> Result<serde_json::Value, String> {
    let installation = emergency_installation()?;
    tauri::async_runtime::spawn_blocking(move || {
        artepool_bridge::emergency::check(&installation, artepool_bridge::emergency::service_state)
    })
    .await
    .map_err(|e| e.to_string())
}

/// One action; the answer (it may hold a temporary password) goes to the window only.
#[tauri::command]
async fn emergency_run(
    action: String,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let installation = emergency_installation()?;
    tauri::async_runtime::spawn_blocking(move || {
        artepool_bridge::emergency::run_action(&installation.launcher(), &action, &input)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Opens `C:\ProgramData\ARTEPOOL\logs` in File Explorer, to send to support.
#[tauri::command]
fn emergency_open_logs() -> Result<(), String> {
    let installation = emergency_installation()?;
    std::process::Command::new("explorer.exe")
        .arg(installation.logs_dir())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
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
    autostart::set_locked(locked);
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

/// The command-line modes that are not the app: the watchdog, and the installer's
/// `--register-autostart` / `--unregister-autostart`. `Some(exit code)` when one ran.
pub fn command_line() -> Option<i32> {
    autostart::command_line(&std::env::args().collect::<Vec<_>>())
}

/// This PC is enrolled as a point of sale (read before any window opens).
#[cfg(windows)]
fn enrolled_as_pos() -> bool {
    artepool_bridge::store::CredentialStore::new("ARTEPOOL ERP", "device")
        .ok()
        .map(|store| Bridge::new(store, env!("CARGO_PKG_VERSION"), computer_name()))
        .and_then(|bridge| bridge.local_device().ok())
        .and_then(|local| local.device)
        .is_some_and(|device| device.kind == "pos")
}

#[cfg(not(windows))]
fn enrolled_as_pos() -> bool {
    true
}

/// Sends the watchdog's report (`restarted` / `not_running`) until the server accepts it; it
/// audits it and alerts the owner (decisions 0082, 0083).
async fn send_kiosk_report(app: tauri::AppHandle, kind: &'static str) {
    for _ in 0..60 {
        let answer = app
            .state::<AppBridge>()
            .0
            .request(BridgeRequest {
                method: "POST".into(),
                path: "/api/v1/kiosk/events".into(),
                body: Some(serde_json::json!({ "kind": kind })),
                token: None,
                idempotency_key: None,
                background: Some(true),
            })
            .await;
        if let Ok(BridgeResponse::Response { status, .. }) = answer {
            if (200..300).contains(&status) {
                autostart::reported();
                return;
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let emergency = emergency_mode();
    let has = |flag: &str| std::env::args().skip(1).any(|arg| arg == flag);
    let restarted = has("--restarted");
    // Started by the sign-in task on every PC: only a point of sale stays open.
    if has("--autostart") && !emergency && !enrolled_as_pos() {
        return;
    }
    let mut builder = tauri::Builder::default();
    // One copy per PC: starting it again brings the open window to the front. The emergency
    // window is a copy of its own, opened while the app may already be running.
    if !emergency {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        // Updates install only with a valid signature from the ARTÉPOOL key (created in M6;
        // until then the public key is empty, so no update can ever be accepted).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let store = open_store(app.handle())?;
            let bridge = Bridge::new(store, env!("CARGO_PKG_VERSION"), computer_name());
            // A PC enrolled as POS starts locked, before the server has even answered. The
            // emergency window never locks: it signs nobody in and does no sales.
            let pos = !emergency
                && bridge
                    .local_device()
                    .ok()
                    .and_then(|d| d.device)
                    .is_some_and(|d| d.kind == "pos");
            app.manage(AppBridge(bridge));
            app.manage(Kiosk(AtomicBool::new(false)));
            app.manage(GoogleSignIn(Mutex::new(None)));
            app.manage(artepool_bridge::restore::RestoreRun::default());
            // The watchdog's state for this run, and what happened to the previous one.
            if !emergency {
                if let Some(kind) = autostart::started(pos, restarted) {
                    tauri::async_runtime::spawn(send_kiosk_report(app.handle().clone(), kind));
                }
                if pos {
                    autostart::start_watchdog();
                }
            }
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
            setup_info,
            setup_request,
            restore_copies,
            restore_start,
            restore_status,
            app_update_check,
            app_update_install,
            emergency_info,
            emergency_check,
            emergency_run,
            emergency_open_logs,
            kiosk_refresh,
            google_signin_start,
            google_signin_open,
            google_signin_wait,
            printer_list,
            printer_print,
            printer_print_image,
            printer_print_label
        ])
        .build(tauri::generate_context!())
        .expect("ARTÉPOOL ERP could not start")
        .run(move |_app, event| {
            // A normal exit (the kiosk lock was off): the watchdog does not start it again.
            if let tauri::RunEvent::Exit = event {
                if !emergency {
                    autostart::exited();
                }
            }
        });
}
