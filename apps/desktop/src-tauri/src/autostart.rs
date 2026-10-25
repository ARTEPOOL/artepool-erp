//! Start at sign-in and the POS watchdog (decisions 0082, 0083; M6.2 part F5). The rules are in
//! `artepool_bridge::watchdog`; this is the Windows side: the scheduled task, the watchdog
//! process, and the state file the app keeps up to date.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

use artepool_bridge::watchdog::{
    KioskState, TASK_NAME, autostart_task_xml, read_state, should_restart, start_report,
    state_file, utf16_file, write_state,
};

/// How long the watchdog waits after the app ended before starting it again: long enough for an
/// installer or an uninstaller to stop the watchdog too.
const RESTART_DELAY: std::time::Duration = std::time::Duration::from_secs(3);

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(windows)]
mod win {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn WaitForSingleObject(handle: isize, millis: u32) -> u32;
        fn CloseHandle(handle: isize) -> i32;
        fn GetTickCount64() -> u64;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetSystemMetrics(index: i32) -> i32;
    }

    /// Waits until the process ends (at once if it has already gone).
    pub fn wait_for_exit(pid: u32) {
        const SYNCHRONIZE: u32 = 0x0010_0000;
        const INFINITE: u32 = 0xFFFF_FFFF;
        let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
        if handle != 0 {
            unsafe {
                WaitForSingleObject(handle, INFINITE);
                CloseHandle(handle);
            }
        }
    }

    /// Seconds since Windows started.
    pub fn uptime() -> u64 {
        unsafe { GetTickCount64() / 1000 }
    }

    /// Windows is signing out or shutting down.
    pub fn shutting_down() -> bool {
        const SM_SHUTTINGDOWN: i32 = 0x2000;
        unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
    }
}

#[cfg(not(windows))]
mod win {
    pub fn wait_for_exit(_pid: u32) {}
    pub fn uptime() -> u64 {
        0
    }
    pub fn shutting_down() -> bool {
        false
    }
}

/// When Windows started (Unix seconds).
fn booted_at() -> u64 {
    now().saturating_sub(win::uptime())
}

/// This Windows user's state file, if there is a local app data folder.
pub fn kiosk_file() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|dir| state_file(std::path::Path::new(&dir)))
}

/// Set once this run keeps the state file (never in the emergency window).
static TRACKING: AtomicBool = AtomicBool::new(false);

fn update(change: impl FnOnce(&mut KioskState)) {
    if !TRACKING.load(Ordering::SeqCst) {
        return;
    }
    let Some(file) = kiosk_file() else { return };
    let mut state = read_state(&file).unwrap_or_default();
    change(&mut state);
    let _ = write_state(&file, &state);
}

/// At start: what to report about the previous run, and this run marked as running.
pub fn started(locked: bool, restarted: bool) -> Option<&'static str> {
    let file = kiosk_file()?;
    TRACKING.store(true, Ordering::SeqCst);
    let previous = read_state(&file);
    let report = start_report(previous.as_ref(), restarted, booted_at());
    let _ = write_state(
        &file,
        &KioskState {
            locked,
            running: true,
            seen_at: now(),
            pending: report.map(str::to_string),
        },
    );
    report
}

pub fn set_locked(locked: bool) {
    update(|s| {
        s.locked = locked;
        s.seen_at = now();
    });
}

/// The server accepted the report.
pub fn reported() {
    update(|s| s.pending = None);
}

/// A normal exit (only possible while the kiosk lock is off): nothing to restart.
pub fn exited() {
    update(|s| s.running = false);
}

/// Starts the watchdog for this app (POS PCs only).
pub fn start_watchdog() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = Command::new(exe)
            .args(["--watchdog", &std::process::id().to_string()])
            .spawn();
    }
}

/// `--watchdog <pid>`: waits for the app to end, then starts it again if it stopped while locked.
fn watchdog(pid: u32) -> i32 {
    win::wait_for_exit(pid);
    std::thread::sleep(RESTART_DELAY);
    let state = kiosk_file().and_then(|file| read_state(&file));
    if should_restart(state.as_ref(), booted_at(), win::shutting_down()) {
        if let Ok(exe) = std::env::current_exe() {
            let _ = Command::new(exe).arg("--restarted").spawn();
        }
    }
    0
}

fn schtasks() -> PathBuf {
    let system = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    std::path::Path::new(&system)
        .join("System32")
        .join("schtasks.exe")
}

/// One line in `C:\ProgramData\ARTEPOOL\logs\install\desktop-app.log`, for support: what the
/// desktop app's installer and uninstaller did. Never a secret: versions, steps and exit codes.
fn install_log(line: &str) {
    use std::io::Write as _;
    let Some(data) = std::env::var_os("ProgramData") else {
        return;
    };
    let dir = std::path::Path::new(&data)
        .join("ARTEPOOL")
        .join("logs")
        .join("install");
    let stamp = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let _ = std::fs::create_dir_all(&dir).and_then(|()| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("desktop-app.log"))
            .and_then(|mut file| writeln!(file, "{stamp} {line}"))
    });
}

/// `--register-autostart` (run by the installer, as administrator): the scheduled task.
fn register() -> i32 {
    let Ok(exe) = std::env::current_exe() else {
        return 1;
    };
    let file = std::env::temp_dir().join(format!("artepool-task-{}.xml", std::process::id()));
    let code = if std::fs::write(&file, utf16_file(&autostart_task_xml(&exe))).is_err() {
        1
    } else {
        let status = Command::new(schtasks())
            .args(["/Create", "/TN", TASK_NAME, "/F", "/XML"])
            .arg(&file)
            .status();
        let _ = std::fs::remove_file(&file);
        status.ok().and_then(|s| s.code()).unwrap_or(1)
    };
    install_log(&format!(
        "ARTEPOOL ERP {} installed in {}; start at sign-in (scheduled task \"{TASK_NAME}\"): exit code {code}",
        env!("CARGO_PKG_VERSION"),
        exe.parent()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    ));
    code
}

/// `--unregister-autostart` (run by the uninstaller): removes the task if it is there.
fn unregister() -> i32 {
    let code = Command::new(schtasks())
        .args(["/Delete", "/TN", TASK_NAME, "/F"])
        .status()
        .ok()
        .and_then(|s| s.code())
        .unwrap_or(1);
    install_log(&format!(
        "ARTEPOOL ERP {} uninstalled; start at sign-in removed: exit code {code}",
        env!("CARGO_PKG_VERSION"),
    ));
    0
}

/// The command-line modes that are not the app itself; `None` starts the app.
pub fn command_line(args: &[String]) -> Option<i32> {
    match args.get(1).map(String::as_str) {
        Some("--watchdog") => Some(
            args.get(2)
                .and_then(|pid| pid.parse::<u32>().ok())
                .map_or(2, watchdog),
        ),
        Some("--register-autostart") => Some(register()),
        Some("--unregister-autostart") => Some(unregister()),
        _ => None,
    }
}
