//! The laptop's and office PCs' quiet updater (decision 0115, 0.9.0): the rules, testable on any
//! system. The Windows side (the scheduled task, Windows' own `curl.exe`, the installer) is in the
//! app (`src/quiet_update.rs`).
//!
//! - A scheduled task "ARTEPOOL App Updater" runs as SYSTEM at any person's sign-in, every hour,
//!   and when the app asks; never on the server PC (its app is updated with the server).
//! - It reads the public update list, downloads the small office update in the background
//!   (continuing after a cut) and keeps it only when its SHA-256 and its signature (the update
//!   key) are right; the signature is checked again right before it runs.
//! - It installs quietly only when the app is closed; someone signed in is never interrupted.
//! - On battery it installs normally unless the battery is below 20%: then it waits for charging
//!   or the next check.
//! - A PC whose WebView2 is missing or broken takes the full office setup (WebView2 offline
//!   inside) instead of the small update.

use std::io::Read as _;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

/// The scheduled task's name in Task Scheduler.
pub const TASK_NAME: &str = "ARTEPOOL App Updater";

/// Where every PC reads the update list (tools/release `LATEST_URL`).
pub const LATEST_URL: &str =
    "https://github.com/ARTEPOOL/artepool-releases/releases/latest/download/latest.json";

/// Below this, on battery, an update waits for charging (the owner's rule, 0115).
pub const LOW_BATTERY_PERCENT: u8 = 20;

/// Only release files are ever downloaded from here.
const DOWNLOAD_PREFIX: &str = "https://github.com/ARTEPOOL/artepool-releases/releases/download/v";

/// One download in the update list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ListedFile {
    pub url: String,
    pub signature: String,
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
}

/// What the quiet updater reads from latest.json.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
    pub version: String,
    #[serde(default)]
    pub office: Option<ListedFile>,
    #[serde(default)]
    pub office_update: Option<ListedFile>,
}

fn parse_version(text: &str) -> Option<[u64; 3]> {
    let mut parts = text.trim().split('.');
    let mut out = [0u64; 3];
    for slot in &mut out {
        *slot = parts.next()?.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// `candidate` is a newer x.y.z than `installed` (anything that is not x.y.z is never newer).
pub fn is_newer(candidate: &str, installed: &str) -> bool {
    match (parse_version(candidate), parse_version(installed)) {
        (Some(a), Some(b)) => a > b,
        (Some(_), None) => true,
        _ => false,
    }
}

/// The file name of a release download: only `ARTEPOOL-Office-(Setup|Update)-<v>.exe` of the
/// releases repository, so nothing else is ever saved or run.
pub fn release_file_name(url: &str) -> Option<String> {
    let rest = url.strip_prefix(DOWNLOAD_PREFIX)?;
    let (version, name) = rest.split_once('/')?;
    parse_version(version)?;
    let ok = (name.starts_with("ARTEPOOL-Office-Setup-")
        || name.starts_with("ARTEPOOL-Office-Update-"))
        && name.ends_with(".exe")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    ok.then(|| name.to_string())
}

fn valid_file(file: &ListedFile) -> bool {
    release_file_name(&file.url).is_some()
        && !file.signature.trim().is_empty()
        && file.sha256.len() == 64
        && file
            .sha256
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// The update list, with only well-formed office downloads kept.
pub fn parse_latest(text: &str) -> Result<Latest, String> {
    let mut latest: Latest =
        serde_json::from_str(text).map_err(|e| format!("not an update list: {e}"))?;
    if parse_version(&latest.version).is_none() {
        return Err(format!("\"{}\" is not a version", latest.version));
    }
    latest.office = latest.office.filter(valid_file);
    latest.office_update = latest.office_update.filter(valid_file);
    Ok(latest)
}

/// Which installer this PC takes (0115).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Package {
    /// The small update (no offline WebView2).
    Small,
    /// The full office setup, for a PC whose WebView2 is missing or broken.
    Full,
}

/// The small update while WebView2 works; the full setup when it does not (or when the list has
/// no small one).
pub fn choose_package(latest: &Latest, webview_ok: bool) -> Option<(Package, &ListedFile)> {
    let small = latest.office_update.as_ref().map(|f| (Package::Small, f));
    let full = latest.office.as_ref().map(|f| (Package::Full, f));
    if webview_ok { small.or(full) } else { full }
}

/// The PC's power, as Windows says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Power {
    /// Plugged in (None: Windows does not know).
    pub on_ac: Option<bool>,
    pub has_battery: bool,
    /// None: Windows does not know.
    pub battery_percent: Option<u8>,
}

/// Installs on mains power, on a PC without a battery, or with 20% or more; waits below 20% on
/// battery (0115). What Windows does not know never blocks an update.
pub fn battery_allows_install(power: Power) -> bool {
    !power.has_battery
        || power.on_ac == Some(true)
        || power
            .battery_percent
            .is_none_or(|percent| percent >= LOW_BATTERY_PERCENT)
}

/// What the quiet updater sees at a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Situation {
    /// The server PC's app is updated with the server, never by this task.
    pub server_pc: bool,
    pub installed: String,
    /// The newest version in the list (None: no list, e.g. no internet).
    pub latest: Option<String>,
    /// That version's installer is downloaded and checked.
    pub ready: bool,
    /// The app is open (someone may be working).
    pub app_open: bool,
    pub power: Power,
    /// The app could not draw its screens (WebView2 broken): the full setup goes in again,
    /// even for the version already installed.
    pub repair: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    NotForThisPc,
    UpToDate,
    Download,
    /// Never while the app is open: someone may be working.
    WaitAppOpen,
    WaitBattery,
    Install,
}

pub fn decide(s: &Situation) -> Decision {
    if s.server_pc {
        return Decision::NotForThisPc;
    }
    let Some(version) = &s.latest else {
        return Decision::UpToDate;
    };
    let same =
        parse_version(version).is_some() && parse_version(version) == parse_version(&s.installed);
    if !is_newer(version, &s.installed) && !(s.repair && same) {
        return Decision::UpToDate;
    }
    if !s.ready {
        return Decision::Download;
    }
    if s.app_open {
        return Decision::WaitAppOpen;
    }
    if !battery_allows_install(s.power) {
        return Decision::WaitBattery;
    }
    Decision::Install
}

/// The file's SHA-256 in lower-case hex, read in pieces.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut context = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        context.update(&buffer[..read]);
    }
    Ok(context
        .finish()
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn minisign_text(base64_text: &str) -> Result<String, String> {
    let bytes = STANDARD
        .decode(base64_text.trim())
        .map_err(|_| "not base64".to_string())?;
    String::from_utf8(bytes).map_err(|_| "not text".to_string())
}

/// The update key's signature of the file (Tauri's format: base64 of the minisign text), read
/// in pieces. Only the prehashed form is accepted, as Tauri's signer makes it.
pub fn verify_file(public_key: &str, signature: &str, path: &Path) -> Result<(), String> {
    let key = minisign_verify::PublicKey::decode(&minisign_text(public_key)?)
        .map_err(|e| format!("the update key is not valid: {e}"))?;
    let signature = minisign_verify::Signature::decode(&minisign_text(signature)?)
        .map_err(|e| format!("the signature is not valid: {e}"))?;
    let mut verifier = key
        .verify_stream(&signature)
        .map_err(|e| format!("the signature does not fit the update key: {e}"))?;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        verifier.update(&buffer[..read]);
    }
    verifier
        .finalize()
        .map_err(|e| format!("the signature does not match the file: {e}"))
}

/// The note beside a part of a download: which address and SHA-256 it belongs to.
pub fn partial_note(file: &ListedFile) -> String {
    format!("{}\n{}\n", file.url, file.sha256)
}

/// Windows' own `curl.exe`: https only, following GitHub's redirect, failing on an HTTP error,
/// and continuing a part already there (`-C -`) unless told to start again.
pub fn curl_args(url: &str, to: &Path, resume: bool, max_seconds: u32) -> Vec<String> {
    let mut args = vec![
        "--fail".into(),
        "--location".into(),
        "--silent".into(),
        "--show-error".into(),
        "--proto".into(),
        "=https".into(),
        "--proto-redir".into(),
        "=https".into(),
        "--max-time".into(),
        max_seconds.to_string(),
    ];
    if resume {
        args.extend(["--continue-at".into(), "-".into()]);
    }
    args.extend(["--output".into(), to.display().to_string(), url.into()]);
    args
}

/// curl's exit code when the server cannot continue a part: start again from nothing.
pub const CURL_CANNOT_RESUME: i32 = 33;

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The scheduled task: as SYSTEM, two minutes after any person signs in, every hour, and on
/// demand. Its security descriptor lets anyone signed in at the PC start it ("Install and
/// restart"), and only SYSTEM and administrators change it; starting it only ever installs a
/// newer version signed with the update key.
pub fn task_xml(app: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>ARTEPOOL ERP: installs a newer signed version of the app quietly, only while it is closed (decision 0115).</Description>
    <SecurityDescriptor>D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;IU)</SecurityDescriptor>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT2M</Delay>
    </LogonTrigger>
    <TimeTrigger>
      <StartBoundary>2026-01-01T00:07:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT1H</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{}</Command>
      <Arguments>--quiet-update</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        xml_escape(&app.display().to_string())
    )
}

/// The app opens again after "Install and restart" when this note is this fresh (seconds).
pub const REOPEN_WITHIN_SECONDS: u64 = 300;

/// A note written at `written` (Unix seconds) still asks the app to stay open at `now`.
pub fn reopen_asked(written: Option<u64>, now: u64) -> bool {
    written.is_some_and(|at| at <= now && now - at <= REOPEN_WITHIN_SECONDS)
}

/// `reg query` of WebView2's per-machine key: its version, or None when it is missing, empty
/// or "0.0.0.0" (Microsoft's own test for an installed WebView2 runtime).
pub fn webview_version(reg_output: &str) -> Option<String> {
    reg_output.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        (parts.next()? == "pv" && parts.next()? == "REG_SZ")
            .then(|| parts.next().map(str::to_string))
            .flatten()
            .filter(|v| !v.is_empty() && v != "0.0.0.0")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../server/test/fixtures/update-signature")
            .join(name)
    }

    fn file(name: &str) -> ListedFile {
        ListedFile {
            url: format!("{DOWNLOAD_PREFIX}0.9.1/{name}"),
            signature: "c2ln".into(),
            sha256: "a".repeat(64),
            size: Some(6_000_000),
        }
    }

    #[test]
    fn versions_and_release_names() {
        assert!(is_newer("0.9.1", "0.9.0"));
        assert!(is_newer("1.0.0", "0.10.9"));
        assert!(!is_newer("0.9.0", "0.9.0"));
        assert!(!is_newer("0.8.9", "0.9.0"));
        assert!(!is_newer("latest", "0.9.0"));
        assert_eq!(
            release_file_name(&file("ARTEPOOL-Office-Update-0.9.1.exe").url).as_deref(),
            Some("ARTEPOOL-Office-Update-0.9.1.exe")
        );
        for url in [
            "https://example.com/v0.9.1/ARTEPOOL-Office-Update-0.9.1.exe",
            "http://github.com/ARTEPOOL/artepool-releases/releases/download/v0.9.1/ARTEPOOL-Office-Update-0.9.1.exe",
            &format!("{DOWNLOAD_PREFIX}0.9.1/ARTEPOOL-Server-Update-0.9.1.exe"),
            &format!("{DOWNLOAD_PREFIX}0.9.1/../evil.exe"),
            &format!("{DOWNLOAD_PREFIX}0.9.1/ARTEPOOL-Office-Update-0.9.1.exe.bat"),
            &format!("{DOWNLOAD_PREFIX}latest/ARTEPOOL-Office-Update-0.9.1.exe"),
        ] {
            assert_eq!(release_file_name(url), None, "{url}");
        }
    }

    #[test]
    fn reads_the_office_parts_of_the_update_list_and_drops_odd_ones() {
        let list = serde_json::json!({
            "version": "0.9.1",
            "server": { "url": "https://x", "signature": "s", "sha256": "b" },
            "office": file("ARTEPOOL-Office-Setup-0.9.1.exe"),
            "officeUpdate": {
                "url": "https://example.com/ARTEPOOL-Office-Update-0.9.1.exe",
                "signature": "s",
                "sha256": "a".repeat(64)
            }
        });
        let latest = parse_latest(&list.to_string()).unwrap();
        assert_eq!(latest.version, "0.9.1");
        assert_eq!(latest.office, Some(file("ARTEPOOL-Office-Setup-0.9.1.exe")));
        // An address outside the releases repository is never kept.
        assert_eq!(latest.office_update, None);
        assert!(parse_latest(r#"{"version":"x"}"#).is_err());
        assert!(parse_latest("<html>").is_err());
    }

    #[test]
    fn the_small_update_while_webview2_works_the_full_setup_when_it_does_not() {
        let latest = Latest {
            version: "0.9.1".into(),
            office: Some(file("ARTEPOOL-Office-Setup-0.9.1.exe")),
            office_update: Some(file("ARTEPOOL-Office-Update-0.9.1.exe")),
        };
        assert_eq!(choose_package(&latest, true).unwrap().0, Package::Small);
        assert_eq!(choose_package(&latest, false).unwrap().0, Package::Full);
        let old = Latest {
            office_update: None,
            ..latest.clone()
        };
        assert_eq!(choose_package(&old, true).unwrap().0, Package::Full);
        let none = Latest {
            office: None,
            ..latest
        };
        assert!(choose_package(&none, false).is_none());
    }

    #[test]
    fn battery_below_20_percent_waits_unless_plugged_in() {
        let battery = |percent: Option<u8>, on_ac: Option<bool>| Power {
            on_ac,
            has_battery: true,
            battery_percent: percent,
        };
        assert!(battery_allows_install(battery(Some(20), Some(false))));
        assert!(battery_allows_install(battery(Some(85), Some(false))));
        assert!(!battery_allows_install(battery(Some(19), Some(false))));
        assert!(!battery_allows_install(battery(Some(5), None)));
        assert!(battery_allows_install(battery(Some(5), Some(true))));
        // What Windows does not know never blocks an update; a desktop PC has no battery.
        assert!(battery_allows_install(battery(None, Some(false))));
        assert!(battery_allows_install(Power::default()));
    }

    #[test]
    fn decides_never_on_the_server_pc_and_never_while_the_app_is_open() {
        let base = Situation {
            server_pc: false,
            installed: "0.9.0".into(),
            latest: Some("0.9.1".into()),
            ready: true,
            app_open: false,
            power: Power::default(),
            repair: false,
        };
        assert_eq!(decide(&base), Decision::Install);
        // A repair puts the same version in again; never an older one.
        let installed = Situation {
            latest: Some("0.9.0".into()),
            ..base.clone()
        };
        assert_eq!(decide(&installed), Decision::UpToDate);
        assert_eq!(
            decide(&Situation {
                repair: true,
                ..installed.clone()
            }),
            Decision::Install
        );
        assert_eq!(
            decide(&Situation {
                repair: true,
                latest: Some("0.8.9".into()),
                ..installed
            }),
            Decision::UpToDate
        );
        assert_eq!(
            decide(&Situation {
                server_pc: true,
                ..base.clone()
            }),
            Decision::NotForThisPc
        );
        assert_eq!(
            decide(&Situation {
                latest: None,
                ..base.clone()
            }),
            Decision::UpToDate
        );
        assert_eq!(
            decide(&Situation {
                latest: Some("0.9.0".into()),
                ..base.clone()
            }),
            Decision::UpToDate
        );
        assert_eq!(
            decide(&Situation {
                ready: false,
                ..base.clone()
            }),
            Decision::Download
        );
        // Downloading in advance goes on while the app is open; installing never does.
        assert_eq!(
            decide(&Situation {
                ready: false,
                app_open: true,
                ..base.clone()
            }),
            Decision::Download
        );
        assert_eq!(
            decide(&Situation {
                app_open: true,
                ..base.clone()
            }),
            Decision::WaitAppOpen
        );
        let low = Power {
            on_ac: Some(false),
            has_battery: true,
            battery_percent: Some(12),
        };
        assert_eq!(
            decide(&Situation { power: low, ..base }),
            Decision::WaitBattery
        );
    }

    #[test]
    fn checks_the_update_keys_signature_of_a_file_read_in_pieces() {
        let key = std::fs::read_to_string(fixture("test.key.pub")).unwrap();
        let signature = std::fs::read_to_string(fixture("data.bin.sig")).unwrap();
        assert_eq!(verify_file(&key, &signature, &fixture("data.bin")), Ok(()));
        // Another file, rubbish, or no key: refused.
        assert!(verify_file(&key, &signature, &fixture("test.key.pub")).is_err());
        assert!(verify_file(&key, "bm90aGluZw==", &fixture("data.bin")).is_err());
        assert!(verify_file("", &signature, &fixture("data.bin")).is_err());
    }

    #[test]
    fn sha256_of_a_file() {
        let dir = std::env::temp_dir().join(format!("artepool-sha-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("abc.txt");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn curl_continues_a_part_over_https_only() {
        let args = curl_args(
            "https://github.com/x.exe",
            Path::new("C:\\u\\x.exe.partial"),
            true,
            3600,
        );
        let text = args.join(" ");
        assert!(text.contains("--proto =https --proto-redir =https"));
        assert!(text.contains("--continue-at -"));
        assert!(text.ends_with("--output C:\\u\\x.exe.partial https://github.com/x.exe"));
        let fresh = curl_args("https://github.com/x.exe", Path::new("x"), false, 60).join(" ");
        assert!(!fresh.contains("--continue-at"));
        assert!(fresh.contains("--max-time 60"));
    }

    #[test]
    fn the_task_runs_as_system_at_sign_in_hourly_and_on_demand() {
        let xml = task_xml(Path::new(r"C:\Program Files\ARTEPOOL ERP\artepool-erp.exe"));
        assert!(xml.contains("<UserId>S-1-5-18</UserId>"));
        assert!(xml.contains("<LogonTrigger>"));
        assert!(xml.contains("<Delay>PT2M</Delay>"));
        assert!(xml.contains("<Interval>PT1H</Interval>"));
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(xml.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
        assert!(xml.contains("<Arguments>--quiet-update</Arguments>"));
        assert!(xml.contains(r"<Command>C:\Program Files\ARTEPOOL ERP\artepool-erp.exe</Command>"));
        // People signed in at the PC may start it; only SYSTEM and administrators change it.
        assert!(xml.contains("D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;IU)"));
    }

    #[test]
    fn reopens_only_after_a_fresh_note() {
        assert!(reopen_asked(Some(1_000), 1_100));
        assert!(!reopen_asked(
            Some(1_000),
            1_000 + REOPEN_WITHIN_SECONDS + 1
        ));
        assert!(!reopen_asked(Some(2_000), 1_000));
        assert!(!reopen_asked(None, 1_000));
    }

    #[test]
    fn reads_webview2s_version_from_reg_query() {
        let installed = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}\r\n    pv    REG_SZ    130.0.2849.80\r\n";
        assert_eq!(webview_version(installed).as_deref(), Some("130.0.2849.80"));
        assert_eq!(webview_version("    pv    REG_SZ    0.0.0.0"), None);
        assert_eq!(
            webview_version(
                "ERROR: The system was unable to find the specified registry key or value."
            ),
            None
        );
    }
}
