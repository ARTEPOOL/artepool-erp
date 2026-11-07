//! The quiet updater on the laptop and the office PCs (decision 0115, 0.9.0): the Windows side of
//! `artepool_bridge::quiet_update`, which holds the rules and their tests.
//!
//! - `--register-quiet-updater` / `--unregister-quiet-updater`: the office setup's hooks register
//!   the scheduled task "ARTEPOOL App Updater" (SYSTEM; at sign-in, hourly, on demand), never on
//!   the server PC.
//! - `--quiet-update`: the task's run. It reads the update list with Windows' own `curl.exe`,
//!   downloads the small office update (or the full setup when WebView2 is missing) into
//!   `C:\ProgramData\ARTEPOOL\app-updates` (written by SYSTEM and administrators only), keeps it
//!   only when its SHA-256 and the update key's signature are right, and installs it only while
//!   the app is closed and the battery allows it.
//! - `--quiet-install <setup> [--reopen]`: runs the installer from a copy of this program in that
//!   folder (the installer stops every `artepool-erp.exe`), checks the signature again right
//!   before, and opens the app again after "Install and restart".
//! - The app itself: "Install and restart" starts the task and closes; a broken WebView2 shows a
//!   clear message and asks the task for the full setup; while an update installs, opening the
//!   app says so.

/// The command-line modes of the quiet updater; `None` when the arguments are not one of them.
pub fn command_line(args: &[String]) -> Option<i32> {
    match args.get(1).map(String::as_str) {
        Some("--quiet-update") => Some(imp::run()),
        Some("--quiet-install") => Some(match args.get(2) {
            Some(setup) => imp::install_now(
                std::path::Path::new(setup),
                args.iter().any(|a| a == "--reopen"),
            ),
            None => 2,
        }),
        Some("--register-quiet-updater") => Some(imp::register()),
        Some("--unregister-quiet-updater") => Some(imp::unregister()),
        _ => None,
    }
}

pub use imp::{ask_repair_and_explain, being_installed, install_and_reopen, reopen_asked_now};

#[cfg(windows)]
mod imp {
    use std::os::windows::process::CommandExt as _;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use artepool_bridge::quiet_update::{
        CURL_CANNOT_RESUME, Decision, LATEST_URL, ListedFile, Power, Situation, TASK_NAME,
        choose_package, curl_args, decide, parse_latest, partial_note, release_file_name,
        reopen_asked, sha256_file, task_xml, verify_file, webview_version,
    };
    use artepool_bridge::watchdog::{TASK_NAME as APP_TASK, utf16_file};

    /// The update key's public half (decision 0108), the same the app's own updater trusts.
    const UPDATE_KEY: &str = include_str!("../../../../release/update-public-key.txt");
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    /// How long "Install and restart" may take to close the app.
    const APP_CLOSE_WAIT: Duration = Duration::from_secs(60);
    /// An install older than this is not "being installed" any more.
    const INSTALLING_FOR: u64 = 15 * 60;
    const WEBVIEW_KEYS: [&str; 2] = [
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ];

    /// Windows fills every field; only the first three are read.
    #[repr(C)]
    #[derive(Default)]
    #[allow(dead_code)]
    struct SystemPowerStatus {
        ac_line_status: u8,
        battery_flag: u8,
        battery_life_percent: u8,
        system_status_flag: u8,
        battery_life_time: u32,
        battery_full_life_time: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemPowerStatus(status: *mut SystemPowerStatus) -> i32;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    fn system32(tool: &str) -> PathBuf {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        Path::new(&root).join("System32").join(tool)
    }

    fn tool(name: &str) -> Command {
        let mut command = Command::new(system32(name));
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    /// `C:\ProgramData\ARTEPOOL\app-updates`.
    fn folder() -> Option<PathBuf> {
        std::env::var_os("ProgramData")
            .map(|data| Path::new(&data).join("ARTEPOOL").join("app-updates"))
    }

    /// The server PC's app is updated with the server, never by this task.
    fn server_pc() -> bool {
        let programs =
            std::env::var_os("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".into());
        Path::new(&programs)
            .join("ARTEPOOL")
            .join("artepool-svc.exe")
            .is_file()
    }

    /// The folder, written by SYSTEM and administrators only, read by everyone (the app reads
    /// the "installing" and "reopen" notes); `requests` inside it, where the app may leave a
    /// repair request (decision 0115).
    fn prepare_folder() -> Option<PathBuf> {
        let dir = folder()?;
        let requests = dir.join("requests");
        if !requests.is_dir() {
            std::fs::create_dir_all(&requests).ok()?;
            let _ = tool("icacls.exe")
                .arg(&dir)
                .args([
                    "/inheritance:r",
                    "/grant:r",
                    "*S-1-5-18:(OI)(CI)F",
                    "*S-1-5-32-544:(OI)(CI)F",
                    "*S-1-5-32-545:(OI)(CI)RX",
                ])
                .status();
            let _ = tool("icacls.exe")
                .arg(&requests)
                .args(["/grant", "*S-1-5-32-545:(OI)(CI)M"])
                .status();
        }
        Some(dir)
    }

    /// One line in `app-updates\updater.log`: versions, steps and exit codes, never a secret.
    fn log(dir: &Path, line: &str) {
        use std::io::Write as _;
        let file = dir.join("updater.log");
        if std::fs::metadata(&file).is_ok_and(|m| m.len() > 1_000_000) {
            let _ = std::fs::rename(&file, dir.join("updater.old.log"));
        }
        let stamp = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(file)
            .and_then(|mut f| writeln!(f, "{stamp} {line}"));
    }

    fn power() -> Power {
        let mut status = SystemPowerStatus::default();
        if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
            return Power::default();
        }
        Power {
            on_ac: match status.ac_line_status {
                0 => Some(false),
                1 => Some(true),
                _ => None,
            },
            // 128: no battery; 255: unknown (never blocks an update).
            has_battery: status.battery_flag != 128 && status.battery_flag != 255,
            battery_percent: (status.battery_life_percent <= 100)
                .then_some(status.battery_life_percent),
        }
    }

    fn webview_ok() -> bool {
        WEBVIEW_KEYS.iter().any(|key| {
            tool("reg.exe")
                .args(["query", key, "/v", "pv"])
                .output()
                .ok()
                .and_then(|out| webview_version(&String::from_utf8_lossy(&out.stdout)))
                .is_some()
        })
    }

    /// Another `artepool-erp.exe` than this one is running.
    fn app_open() -> bool {
        let own = std::process::id().to_string();
        tool("tasklist.exe")
            .args(["/FI", "IMAGENAME eq artepool-erp.exe", "/FO", "CSV", "/NH"])
            .output()
            .map(|out| {
                String::from_utf8_lossy(&out.stdout).lines().any(|line| {
                    let mut fields = line.split("\",\"");
                    fields.next().is_some_and(|name| {
                        name.trim_matches('"')
                            .eq_ignore_ascii_case("artepool-erp.exe")
                    }) && fields
                        .next()
                        .is_some_and(|pid| pid.trim_matches('"') != own)
                })
            })
            .unwrap_or(false)
    }

    fn curl(url: &str, to: &Path, resume: bool, seconds: u32) -> i32 {
        tool("curl.exe")
            .args(curl_args(url, to, resume, seconds))
            .status()
            .ok()
            .and_then(|s| s.code())
            .unwrap_or(1)
    }

    fn fetch_latest(dir: &Path) -> Result<artepool_bridge::quiet_update::Latest, String> {
        let file = dir.join("latest.json");
        let _ = std::fs::remove_file(&file);
        let code = curl(LATEST_URL, &file, false, 60);
        if code != 0 {
            return Err(format!("the update list could not be read (curl {code})"));
        }
        parse_latest(&std::fs::read_to_string(&file).map_err(|e| e.to_string())?)
    }

    /// Into `target`, continuing a part already there; kept only with the right SHA-256 and the
    /// update key's signature.
    fn download(file: &ListedFile, target: &Path) -> Result<(), String> {
        let partial = target.with_extension("exe.partial");
        let note = target.with_extension("exe.partial.note");
        if partial.exists()
            && std::fs::read_to_string(&note).ok().as_deref() != Some(&partial_note(file))
        {
            let _ = std::fs::remove_file(&partial);
        }
        std::fs::write(&note, partial_note(file)).map_err(|e| e.to_string())?;
        let mut code = curl(&file.url, &partial, partial.exists(), 3600);
        if code == CURL_CANNOT_RESUME {
            let _ = std::fs::remove_file(&partial);
            code = curl(&file.url, &partial, false, 3600);
        }
        if code != 0 {
            return Err(format!(
                "the download stopped (curl {code}); the next run continues it"
            ));
        }
        let refuse = |why: String| {
            let _ = std::fs::remove_file(&partial);
            let _ = std::fs::remove_file(&note);
            Err(why)
        };
        match sha256_file(&partial) {
            Ok(sha) if sha == file.sha256 => {}
            _ => return refuse("the download does not match its SHA-256".into()),
        }
        let name = target
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("the download has no file name")?;
        if let Err(why) = verify_file(UPDATE_KEY, &file.signature, &partial, name) {
            return refuse(why);
        }
        std::fs::write(target.with_extension("exe.sig"), &file.signature)
            .map_err(|e| e.to_string())?;
        std::fs::rename(&partial, target).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&note);
        Ok(())
    }

    fn wait_app_closed() -> bool {
        let until = std::time::Instant::now() + APP_CLOSE_WAIT;
        while std::time::Instant::now() < until {
            if !app_open() {
                return true;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        !app_open()
    }

    /// `--quiet-update`: the scheduled task's run.
    pub fn run() -> i32 {
        if server_pc() {
            return 0;
        }
        let Some(dir) = prepare_folder() else {
            return 1;
        };
        let repair_request = dir.join("requests").join("webview-repair");
        let repair = repair_request.exists();
        // "Install and restart" (or the sign-in screen) asked for the app to open again after.
        let reopen_request = dir.join("requests").join("reopen");
        let reopen_wanted = reopen_asked(
            std::fs::read_to_string(&reopen_request)
                .ok()
                .and_then(|t| t.trim().parse().ok()),
            now(),
        );
        let latest = match fetch_latest(&dir) {
            Ok(latest) => latest,
            Err(why) => {
                log(&dir, &why);
                return 0;
            }
        };
        let webview = webview_ok() && !repair;
        let Some((package, file)) = choose_package(&latest, webview) else {
            log(&dir, "the update list has no office installer");
            return 0;
        };
        let Some(name) = release_file_name(&file.url) else {
            return 1;
        };
        let target = dir.join(&name);
        let mut situation = Situation {
            server_pc: false,
            installed: env!("CARGO_PKG_VERSION").to_string(),
            latest: Some(latest.version.clone()),
            ready: target.is_file() && target.with_extension("exe.sig").is_file(),
            app_open: app_open(),
            power: power(),
            repair,
        };
        if decide(&situation) == Decision::Download {
            if let Err(why) = download(file, &target) {
                log(&dir, &format!("{}: {why}", latest.version));
                return 0;
            }
            log(
                &dir,
                &format!("{name} downloaded and checked ({package:?})"),
            );
            situation.ready = true;
            situation.app_open = app_open();
        }
        let mut reopen = reopen_wanted;
        if decide(&situation) == Decision::WaitAppOpen {
            // "Install and restart" starts this task, then the app closes by itself.
            if !wait_app_closed() {
                log(
                    &dir,
                    &format!("{}: waiting, the app is open", latest.version),
                );
                return 0;
            }
            situation.app_open = false;
            reopen = true;
        }
        match decide(&situation) {
            Decision::Install => {}
            Decision::WaitBattery => {
                log(
                    &dir,
                    &format!("{}: waiting, the battery is below 20%", latest.version),
                );
                return 0;
            }
            _ => return 0,
        }
        if repair {
            let _ = std::fs::remove_file(&repair_request);
        }
        let _ = std::fs::remove_file(&reopen_request);
        // From a copy outside the app's folder: the installer stops every artepool-erp.exe.
        let runner = dir.join("artepool-app-updater.exe");
        let started = std::env::current_exe()
            .and_then(|exe| std::fs::copy(exe, &runner))
            .and_then(|_| {
                let mut command = Command::new(&runner);
                command.arg("--quiet-install").arg(&target);
                if reopen {
                    command.arg("--reopen");
                }
                command.creation_flags(CREATE_NO_WINDOW).spawn()
            });
        match started {
            Ok(_) => 0,
            Err(e) => {
                log(&dir, &format!("the installer could not be started: {e}"));
                1
            }
        }
    }

    /// `--quiet-install <setup> [--reopen]`: checked again, installed silently, cleaned up.
    pub fn install_now(setup: &Path, reopen: bool) -> i32 {
        let Some(dir) = folder() else {
            return 1;
        };
        // Only a file of this folder, with its signature checked right before it runs.
        if setup.parent() != Some(dir.as_path()) {
            return 2;
        }
        let signature =
            std::fs::read_to_string(setup.with_extension("exe.sig")).unwrap_or_default();
        let name = setup
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if let Err(why) = verify_file(UPDATE_KEY, &signature, setup, name) {
            log(&dir, &format!("refused before running: {why}"));
            let _ = std::fs::remove_file(setup);
            return 1;
        }
        let marker = dir.join("installing");
        let _ = std::fs::write(&marker, now().to_string());
        let code = Command::new(setup)
            .arg("/S")
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .ok()
            .and_then(|s| s.code())
            .unwrap_or(1);
        let _ = std::fs::remove_file(&marker);
        log(
            &dir,
            &format!(
                "{} installed quietly: exit code {code}",
                setup
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            ),
        );
        if code == 0 {
            let _ = std::fs::remove_file(setup);
            let _ = std::fs::remove_file(setup.with_extension("exe.sig"));
        }
        if reopen {
            // The app's own sign-in task opens it for the person; the note keeps it open.
            let _ = std::fs::write(dir.join("reopen"), now().to_string());
            let _ = tool("schtasks.exe")
                .args(["/Run", "/TN", APP_TASK])
                .status();
        }
        if code == 0 { 0 } else { 1 }
    }

    /// `--register-quiet-updater` (the office setup's hook, as administrator).
    pub fn register() -> i32 {
        if server_pc() {
            let _ = unregister();
            return 0;
        }
        let Ok(exe) = std::env::current_exe() else {
            return 1;
        };
        let file = std::env::temp_dir().join(format!("artepool-quiet-{}.xml", std::process::id()));
        if std::fs::write(&file, utf16_file(&task_xml(&exe))).is_err() {
            return 1;
        }
        let code = tool("schtasks.exe")
            .args(["/Create", "/TN", TASK_NAME, "/F", "/XML"])
            .arg(&file)
            .status()
            .ok()
            .and_then(|s| s.code())
            .unwrap_or(1);
        let _ = std::fs::remove_file(&file);
        if let Some(dir) = prepare_folder() {
            log(
                &dir,
                &format!("scheduled task \"{TASK_NAME}\" registered: exit code {code}"),
            );
        }
        code
    }

    /// `--unregister-quiet-updater` (the uninstaller's hook).
    pub fn unregister() -> i32 {
        let _ = tool("schtasks.exe")
            .args(["/Delete", "/TN", TASK_NAME, "/F"])
            .status();
        0
    }

    /// "Install and restart": asks for the app to open again after, then starts the task. True
    /// when Windows started it (the app then closes).
    pub fn install_and_reopen() -> bool {
        if server_pc() {
            return false;
        }
        if let Some(dir) = folder() {
            let _ = std::fs::write(dir.join("requests").join("reopen"), now().to_string());
        }
        wake()
    }

    /// Starts the task now. True when Windows started it.
    fn wake() -> bool {
        !server_pc()
            && tool("schtasks.exe")
                .args(["/Run", "/TN", TASK_NAME])
                .status()
                .is_ok_and(|s| s.success())
    }

    fn note_time(name: &str) -> Option<u64> {
        std::fs::read_to_string(folder()?.join(name))
            .ok()
            .and_then(|text| text.trim().parse().ok())
    }

    /// An update is being installed right now.
    pub fn being_installed() -> bool {
        note_time("installing").is_some_and(|at| at <= now() && now() - at < INSTALLING_FOR)
    }

    /// The app was just updated after "Install and restart": it stays open.
    pub fn reopen_asked_now() -> bool {
        reopen_asked(note_time("reopen"), now())
    }

    fn message(text: &str) {
        let wide = |s: &str| {
            s.encode_utf16()
                .chain(std::iter::once(0))
                .collect::<Vec<u16>>()
        };
        const MB_ICONWARNING: u32 = 0x30;
        const MB_SETFOREGROUND: u32 = 0x0001_0000;
        unsafe {
            MessageBoxW(
                0,
                wide(text).as_ptr(),
                wide("ARTEPOOL ERP").as_ptr(),
                MB_ICONWARNING | MB_SETFOREGROUND,
            );
        }
    }

    /// The app could not draw its screens: a clear message, and the full setup asked for.
    pub fn ask_repair_and_explain() {
        if !server_pc() {
            if let Some(dir) = folder() {
                let _ = std::fs::write(
                    dir.join("requests").join("webview-repair"),
                    now().to_string(),
                );
            }
            let _ = wake();
        }
        message(
            "الجزء اللي بيرسم شاشات آرتيبول (WebView2) ناقص أو بايظ على الجهاز ده.\n\
             آرتيبول بيصلّحه لوحده دلوقتي بالملف الكامل. افتح البرنامج تاني بعد دقايق.\n\
             لو المشكلة فضلت: شغّل ARTEPOOL-Office-Setup من صفحة الإصدارات.\n\n\
             The part that draws ARTEPOOL's screens (WebView2) is missing or broken on this PC.\n\
             ARTEPOOL is repairing it by itself now with the full setup. Open it again in a few minutes.\n\
             If it stays: run ARTEPOOL-Office-Setup from the releases page.",
        );
    }

    /// Shown instead of the app while an update installs.
    pub fn tell_being_installed() {
        message(
            "آرتيبول بيتحدّث دلوقتي. افتحه تاني بعد دقيقة.\n\n\
             ARTEPOOL is being updated. Open it again in a minute.",
        );
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::Path;

    pub fn run() -> i32 {
        0
    }
    pub fn install_now(_setup: &Path, _reopen: bool) -> i32 {
        0
    }
    pub fn register() -> i32 {
        0
    }
    pub fn unregister() -> i32 {
        0
    }
    pub fn install_and_reopen() -> bool {
        false
    }
    pub fn being_installed() -> bool {
        false
    }
    pub fn reopen_asked_now() -> bool {
        false
    }
    pub fn ask_repair_and_explain() {}
    pub fn tell_being_installed() {}
}

pub use imp::tell_being_installed;
