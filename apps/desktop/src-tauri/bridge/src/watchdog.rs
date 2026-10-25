//! The POS app's watchdog and start at sign-in (decisions 0082, 0083; M6.2 part F5).
//!
//! - A Windows scheduled task starts the app at every sign-in (`--autostart`); on a PC that is not
//!   enrolled as POS the app closes again at once.
//! - On a POS PC the app starts a small copy of itself (`--watchdog <pid>`) that waits for it to
//!   end. If it ends while the kiosk lock is on, without a normal exit and not because Windows is
//!   shutting down, the watchdog starts it again (`--restarted`).
//! - The app keeps a small state file for this. At the next start it reports to the server
//!   `restarted` (brought back by the watchdog) or `not_running` (it had stopped while locked and
//!   nothing brought it back); the server audits it and alerts the owner.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The scheduled task's name in Task Scheduler.
pub const TASK_NAME: &str = "ARTEPOOL ERP";

/// What the app remembers between runs (`%LOCALAPPDATA%\ARTEPOOL\kiosk-state.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KioskState {
    /// The kiosk lock was on.
    pub locked: bool,
    /// The app was running: set at start, cleared by a normal exit.
    pub running: bool,
    /// When the running app last wrote this (Unix seconds), to tell a stop from a shutdown.
    pub seen_at: u64,
    /// A report not yet accepted by the server (`restarted` or `not_running`).
    pub pending: Option<String>,
}

pub fn state_file(local_app_data: &Path) -> PathBuf {
    local_app_data.join("ARTEPOOL").join("kiosk-state.json")
}

pub fn read_state(file: &Path) -> Option<KioskState> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

pub fn write_state(file: &Path, state: &KioskState) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temporary = file.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec(state).unwrap_or_default())?;
    std::fs::rename(temporary, file)
}

/// The app stopped while locked, without a normal exit, while Windows kept running: `seen_at`
/// is after this boot (a shutdown or restart of the PC is not a stop).
pub fn stopped_while_locked(state: &KioskState, booted_at: u64) -> bool {
    state.locked && state.running && state.seen_at >= booted_at
}

/// What to report at start: the previous run's unsent report, else what happened to it.
pub fn start_report(
    previous: Option<&KioskState>,
    restarted: bool,
    booted_at: u64,
) -> Option<&'static str> {
    let pending = previous
        .and_then(|p| p.pending.as_deref())
        .and_then(|kind| match kind {
            "restarted" => Some("restarted"),
            "not_running" => Some("not_running"),
            _ => None,
        });
    if restarted {
        return Some("restarted");
    }
    if previous.is_some_and(|p| stopped_while_locked(p, booted_at)) {
        return Some("not_running");
    }
    pending
}

/// The watchdog's choice once the app has ended: start it again only if it stopped while locked.
pub fn should_restart(state: Option<&KioskState>, booted_at: u64, shutting_down: bool) -> bool {
    !shutting_down && state.is_some_and(|s| stopped_while_locked(s, booted_at))
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The scheduled task: at any person's sign-in, the app with `--autostart`, as that person
/// (the Users group, least privilege), never stopped for running long or on battery.
pub fn autostart_task_xml(app: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>ARTEPOOL ERP: starts the app at sign-in (POS PCs only stay open).</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <GroupId>S-1-5-32-545</GroupId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{}</Command>
      <Arguments>--autostart</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        xml_escape(&app.display().to_string())
    )
}

/// Task Scheduler reads a task file in UTF-16 (little endian, with its byte order mark).
pub fn utf16_file(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOOT: u64 = 1_000_000;

    fn state(locked: bool, running: bool, seen_at: u64) -> KioskState {
        KioskState {
            locked,
            running,
            seen_at,
            pending: None,
        }
    }

    #[test]
    fn restarts_only_after_a_stop_while_locked_and_not_at_shutdown() {
        assert!(should_restart(
            Some(&state(true, true, BOOT + 5)),
            BOOT,
            false
        ));
        // A normal exit (only possible while unlocked), or unlocked, or Windows shutting down.
        assert!(!should_restart(
            Some(&state(true, false, BOOT + 5)),
            BOOT,
            false
        ));
        assert!(!should_restart(
            Some(&state(false, true, BOOT + 5)),
            BOOT,
            false
        ));
        assert!(!should_restart(
            Some(&state(true, true, BOOT + 5)),
            BOOT,
            true
        ));
        // Last seen before this boot: the PC was turned off, not the app stopped.
        assert!(!should_restart(
            Some(&state(true, true, BOOT - 5)),
            BOOT,
            false
        ));
        assert!(!should_restart(None, BOOT, false));
    }

    #[test]
    fn reports_restarted_or_not_running_at_start_and_keeps_an_unsent_report() {
        assert_eq!(start_report(None, false, BOOT), None);
        assert_eq!(start_report(None, true, BOOT), Some("restarted"));
        assert_eq!(
            start_report(Some(&state(true, true, BOOT + 9)), false, BOOT),
            Some("not_running")
        );
        assert_eq!(
            start_report(Some(&state(true, true, BOOT - 9)), false, BOOT),
            None
        );
        assert_eq!(
            start_report(Some(&state(false, false, BOOT + 9)), false, BOOT),
            None
        );
        let unsent = KioskState {
            pending: Some("restarted".into()),
            ..state(true, false, BOOT - 9)
        };
        assert_eq!(start_report(Some(&unsent), false, BOOT), Some("restarted"));
        let odd = KioskState {
            pending: Some("anything".into()),
            ..KioskState::default()
        };
        assert_eq!(start_report(Some(&odd), false, BOOT), None);
    }

    #[test]
    fn keeps_the_state_in_a_file() {
        let dir = std::env::temp_dir().join(format!("artepool-watchdog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = state_file(&dir);
        assert_eq!(read_state(&file), None);
        let saved = KioskState {
            pending: Some("not_running".into()),
            ..state(true, true, 42)
        };
        write_state(&file, &saved).unwrap();
        assert_eq!(read_state(&file), Some(saved));
        std::fs::write(&file, b"not json").unwrap();
        assert_eq!(read_state(&file), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_task_starts_the_app_at_sign_in_for_every_user_without_rights() {
        let xml = autostart_task_xml(Path::new(r"C:\Program Files\ARTEPOOL ERP\artepool-erp.exe"));
        assert!(xml.contains("<LogonTrigger>"));
        assert!(xml.contains("<GroupId>S-1-5-32-545</GroupId>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(xml.contains(r"<Command>C:\Program Files\ARTEPOOL ERP\artepool-erp.exe</Command>"));
        assert!(xml.contains("<Arguments>--autostart</Arguments>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(
            autostart_task_xml(Path::new("C:/a&b/<x>.exe")).contains("C:/a&amp;b/&lt;x&gt;.exe")
        );
        let bytes = utf16_file("<a/>");
        assert_eq!(&bytes[..4], &[0xFF, 0xFE, b'<', 0]);
        assert_eq!(bytes.len(), 2 + 4 * 2);
    }
}
