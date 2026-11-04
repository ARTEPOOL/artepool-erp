//! The cashier's Windows account (M6.4, decision 0085, simplified by the owner on 2026-11-04):
//!
//!   artepool-svc cashier-account check | setup | disable
//!
//! - `setup` (set up or repair, safe to run again): a standard account `artepool-pos` («الكاشير»)
//!   with a new random password kept only as the LSA secret, automatic sign-in to it, the shared
//!   enrollment folder, the ARTEPOOL folder and `updates` closed to standard accounts, and Windows
//!   Update's active hours 08:00–24:00. No other Windows limits.
//! - `check` (read only): what is right and what is missing, as JSON.
//! - `disable` (uninstall): automatic sign-in off, the secret deleted, the account disabled.
//!
//! This file holds the rules as plain data and functions, tested on any system; the Windows
//! calls are in `cashier_windows.rs`.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::{Layout, SvcError};

/// The account's Windows user name, and the name Windows shows on its sign-in screen.
pub const ACCOUNT: &str = "artepool-pos";
pub const FULL_NAME: &str = "الكاشير";
pub const COMMENT: &str = "ARTEPOOL: the cashier's account (standard user, signs in by itself).";

/// Well-known SIDs, the same on every Windows in every language.
pub const SYSTEM: &str = "S-1-5-18";
pub const ADMINISTRATORS: &str = "S-1-5-32-544";
pub const USERS: &str = "S-1-5-32-545";
pub const AUTHENTICATED_USERS: &str = "S-1-5-11";
pub const EVERYONE: &str = "S-1-1-0";
pub const INTERACTIVE: &str = "S-1-5-4";

/// Who a standard account is, for Windows' access rules: itself and these groups.
pub fn standard_identities(cashier_sid: Option<&str>) -> Vec<String> {
    let mut sids: Vec<String> = [USERS, AUTHENTICATED_USERS, EVERYONE, INTERACTIVE]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(sid) = cashier_sid {
        sids.push(sid.to_string());
    }
    sids
}

/// The three services of the installation (M6.2 part F).
pub const SERVICES: [&str; 3] = ["ArtepoolDatabase", "ArtepoolServer", "ArtepoolBackup"];

/// Windows Update's active hours (owner, 2026-11-04): no restart from 08:00 to 24:00.
pub const ACTIVE_HOURS_START: u32 = 8;
/// 24:00 is written as 0 (midnight).
pub const ACTIVE_HOURS_END: u32 = 0;
pub const ACTIVE_HOURS_KEY: &str = r"SOFTWARE\Microsoft\WindowsUpdate\UX\Settings";
pub const WINLOGON_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon";
/// The LSA secret Windows reads for automatic sign-in (the way Microsoft's Autologon keeps it).
pub const LSA_DEFAULT_PASSWORD: &str = "DefaultPassword";

/// The shared enrollment of the server PC (the app keeps it here when the folder exists).
pub const DEVICE_FOLDER: &str = "device";
pub const ENROLLMENT_FILE: &str = "enrollment.dat";

/// One access rule (ACE) of a folder or a service, as Windows keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    pub sid: String,
    pub mask: u32,
    pub allow: bool,
    /// Applies only to what is created inside, not to the folder itself.
    pub inherit_only: bool,
}

/// What a standard account may do in the ARTEPOOL folder itself: list it and read it, never
/// create, change or delete anything (FILE_GENERIC_READ | FILE_GENERIC_EXECUTE).
const READ_AND_LIST: u32 = 0x0012_00A9;
const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_EXECUTE: u32 = 0x2000_0000;

fn applies_to(rule: &Rule, who: &[String]) -> bool {
    rule.allow && !rule.inherit_only && who.iter().any(|sid| sid == &rule.sid)
}

/// A closed folder (data, secrets, backups, logs…): no rule lets a standard account in at all.
pub fn folder_closed(rules: &[Rule], who: &[String]) -> bool {
    !rules.iter().any(|r| applies_to(r, who))
}

/// The ARTEPOOL folder itself: a standard account may read and list it, nothing more. Rules
/// for what is created inside (inherit only) count too: they decide what a new folder allows.
pub fn folder_read_only(rules: &[Rule], who: &[String]) -> bool {
    rules
        .iter()
        .filter(|r| r.allow && who.iter().any(|sid| sid == &r.sid))
        .all(|r| r.mask & !(READ_AND_LIST | GENERIC_READ | GENERIC_EXECUTE) == 0)
}

/// What a standard account must never do to a service: stop it, pause it, change it, delete it,
/// or change its rules (SERVICE_CHANGE_CONFIG, SERVICE_STOP, SERVICE_PAUSE_CONTINUE, DELETE,
/// WRITE_DAC, WRITE_OWNER, and the generic rights that include them).
const SERVICE_FORBIDDEN: u32 =
    0x0002 | 0x0020 | 0x0040 | 0x0001_0000 | 0x0004_0000 | 0x0008_0000 | 0xF000_0000;

pub fn service_closed(rules: &[Rule], who: &[String]) -> bool {
    !rules
        .iter()
        .any(|r| applies_to(r, who) && r.mask & SERVICE_FORBIDDEN != 0)
}

/// The installation's folders a standard account must not open (M6.2 part F), and the backups
/// folder from the settings file when it is elsewhere.
pub fn closed_folders(layout: &Layout, backup_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let data = &layout.data_dir;
    let mut folders: Vec<PathBuf> = [
        "pgdata", "wal", "logs", "secrets", "config", "setup", "updates",
    ]
    .iter()
    .map(|name| data.join(name))
    .collect();
    folders.push(backup_dir.unwrap_or_else(|| data.join("backups")));
    folders
}

/// The backups folder named in the settings file, if any.
pub fn backup_dir_from_settings(settings: &str) -> Option<PathBuf> {
    let value: Value = serde_json::from_str(settings).ok()?;
    value
        .get("backupDir")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// `icacls` arguments, by SID (an Arabic Windows names the groups differently):
/// - the ARTEPOOL folder: SYSTEM and Administrators in full; standard accounts read and list it
///   only (nothing passed down, so a new folder inside is closed to them);
/// - `updates` (the SYSTEM updater's folder): back to plain inherited rules, i.e. closed;
/// - `device` (the shared enrollment): standard accounts read and change it (the device key's
///   renewal writes it), nobody else besides SYSTEM and Administrators.
pub fn icacls_root(data_dir: &Path) -> Vec<String> {
    vec![
        data_dir.display().to_string(),
        "/inheritance:r".into(),
        "/grant:r".into(),
        format!("*{SYSTEM}:(OI)(CI)F"),
        format!("*{ADMINISTRATORS}:(OI)(CI)F"),
        format!("*{USERS}:RX"),
        "/C".into(),
        "/Q".into(),
    ]
}

pub fn icacls_reset(folder: &Path) -> Vec<String> {
    vec![
        folder.display().to_string(),
        "/reset".into(),
        "/T".into(),
        "/C".into(),
        "/Q".into(),
    ]
}

pub fn icacls_device(folder: &Path) -> Vec<String> {
    vec![
        folder.display().to_string(),
        "/inheritance:r".into(),
        "/grant:r".into(),
        format!("*{SYSTEM}:(OI)(CI)F"),
        format!("*{ADMINISTRATORS}:(OI)(CI)F"),
        format!("*{USERS}:(OI)(CI)M"),
        "/C".into(),
        "/Q".into(),
    ]
}

/// A new password for the account: 32 characters from Windows' secure random source, with at
/// least one capital, one small letter, one digit and one symbol (so a PC with Windows' password
/// complexity rule on accepts it too). Never shown, logged or written to a file.
pub fn generate_password() -> Result<Zeroizing<String>, SvcError> {
    const UPPER: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
    const LOWER: &[u8] = b"abcdefghijkmnopqrstuvwxyz";
    const DIGITS: &[u8] = b"23456789";
    const SYMBOLS: &[u8] = b"!#%+-=?@_~";
    const LENGTH: usize = 32;
    let all: Vec<u8> = [UPPER, LOWER, DIGITS, SYMBOLS].concat();
    let mut random = Zeroizing::new([0u8; LENGTH * 2]);
    getrandom::fill(random.as_mut())
        .map_err(|e| SvcError::Io(format!("No random numbers: {e}")))?;
    let mut chars = Zeroizing::new(vec![0u8; LENGTH]);
    for (i, slot) in chars.iter_mut().enumerate() {
        // 256 is not a multiple of the alphabet: two bytes per character keep the bias tiny.
        let n = u16::from_le_bytes([random[2 * i], random[2 * i + 1]]) as usize;
        *slot = all[n % all.len()];
    }
    // One of each class at positions chosen by the last random bytes (distinct, from the end).
    for (k, class) in [UPPER, LOWER, DIGITS, SYMBOLS].iter().enumerate() {
        if !chars.iter().any(|c| class.contains(c)) {
            let at = (random[LENGTH * 2 - 1 - k] as usize % (LENGTH / 4)) + k * (LENGTH / 4);
            chars[at] = class[random[k] as usize % class.len()];
        }
    }
    let text = String::from_utf8(chars.to_vec())
        .map_err(|_| SvcError::Io("The new password is not text".into()))?;
    Ok(Zeroizing::new(text))
}

/// 32 printable characters or more, with a capital, a small letter, a digit and a symbol.
pub fn strong_enough(text: &str) -> bool {
    text.len() >= 32
        && text.bytes().all(|b| b.is_ascii_graphic())
        && text.bytes().any(|b| b.is_ascii_uppercase())
        && text.bytes().any(|b| b.is_ascii_lowercase())
        && text.bytes().any(|b| b.is_ascii_digit())
        && text.bytes().any(|b| !b.is_ascii_alphanumeric())
}

/// The Winlogon values for automatic sign-in to the account. The password itself is never
/// here: it is the LSA secret, and a plain `DefaultPassword` value is deleted.
pub fn winlogon_values(computer: &str) -> Vec<(&'static str, String)> {
    vec![
        ("AutoAdminLogon", "1".into()),
        ("DefaultUserName", ACCOUNT.into()),
        ("DefaultDomainName", computer.into()),
    ]
}

/// Values removed at `setup`: a plain password, and a count that ends automatic sign-in.
pub const WINLOGON_REMOVED: [&str; 2] = ["DefaultPassword", "AutoLogonCount"];

/// What `check` sees on the PC.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Observed {
    pub account_exists: bool,
    pub enabled: bool,
    pub never_expires: bool,
    pub in_users: bool,
    pub in_administrators: bool,
    pub auto_sign_in: bool,
    pub secret_stored: bool,
    pub plain_password: bool,
    pub active_hours: bool,
    pub enrollment_shared: bool,
    /// The folders a standard account can open, and whether the ARTEPOOL folder is read only.
    pub open_folders: Vec<String>,
    pub root_read_only: bool,
    /// The services a standard account could stop or change, or whose rules could not be read.
    pub open_services: Vec<String>,
}

/// The names of what is missing, as the screens and the audit log show them.
pub fn missing(o: &Observed) -> Vec<&'static str> {
    let mut items = Vec::new();
    if !o.account_exists {
        items.push("account");
        return items;
    }
    if !o.enabled {
        items.push("enabled");
    }
    if !o.in_users || o.in_administrators {
        items.push("standard");
    }
    if !o.never_expires {
        items.push("password_expiry");
    }
    if !o.auto_sign_in {
        items.push("auto_sign_in");
    }
    if !o.secret_stored {
        items.push("password_stored");
    }
    if o.plain_password {
        items.push("plain_password");
    }
    if !o.enrollment_shared {
        items.push("enrollment");
    }
    if !o.open_folders.is_empty() || !o.root_read_only {
        items.push("folders");
    }
    if !o.open_services.is_empty() {
        items.push("services");
    }
    if !o.active_hours {
        items.push("active_hours");
    }
    items
}

/// `ok`, `repair` (the account is there, something is missing) or `not_set_up`.
pub fn state(o: &Observed) -> &'static str {
    match missing(o).as_slice() {
        [] => "ok",
        ["account"] => "not_set_up",
        _ => "repair",
    }
}

/// The JSON `check` prints: never a password.
pub fn report(o: &Observed) -> Value {
    json!({
        "state": state(o),
        "missing": missing(o),
        "account": ACCOUNT,
        "openFolders": o.open_folders,
        "openServices": o.open_services,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(sid: &str, mask: u32) -> Rule {
        Rule {
            sid: sid.into(),
            mask,
            allow: true,
            inherit_only: false,
        }
    }

    fn all_right() -> Observed {
        Observed {
            account_exists: true,
            enabled: true,
            never_expires: true,
            in_users: true,
            in_administrators: false,
            auto_sign_in: true,
            secret_stored: true,
            plain_password: false,
            active_hours: true,
            enrollment_shared: true,
            open_folders: vec![],
            root_read_only: true,
            open_services: vec![],
        }
    }

    const CASHIER: &str = "S-1-5-21-1-2-3-1001";

    #[test]
    fn a_closed_folder_lets_no_standard_account_in() {
        let who = standard_identities(Some(CASHIER));
        let closed = [rule(SYSTEM, 0x1F01FF), rule(ADMINISTRATORS, 0x1F01FF)];
        assert!(folder_closed(&closed, &who));
        for sid in [USERS, AUTHENTICATED_USERS, EVERYONE, INTERACTIVE, CASHIER] {
            let mut open = closed.to_vec();
            open.push(rule(sid, 0x1200A9));
            assert!(!folder_closed(&open, &who), "{sid}");
        }
        // A deny rule, or a rule only for new files, never opens it.
        let mut denied = closed.to_vec();
        denied.push(Rule {
            allow: false,
            ..rule(USERS, 0x1F01FF)
        });
        denied.push(Rule {
            inherit_only: true,
            ..rule(USERS, 0x1F01FF)
        });
        assert!(folder_closed(&denied, &who));
        // A service's own account is not a standard account.
        let service = rule("S-1-5-80-1-2-3-4-5", 0x1F01FF);
        assert!(folder_closed(&[service], &who));
    }

    #[test]
    fn the_artepool_folder_may_be_read_but_never_written() {
        let who = standard_identities(Some(CASHIER));
        assert!(folder_read_only(
            &[rule(SYSTEM, 0x1F01FF), rule(USERS, 0x1200A9)],
            &who
        ));
        // ProgramData's default: standard accounts may create files and folders.
        assert!(!folder_read_only(&[rule(USERS, 0x6)], &who));
        let creator = Rule {
            inherit_only: true,
            ..rule(USERS, 0x6)
        };
        assert!(!folder_read_only(&[creator], &who));
        assert!(!folder_read_only(&[rule(CASHIER, 0x1301BF)], &who));
    }

    #[test]
    fn a_standard_account_must_not_stop_or_change_a_service() {
        let who = standard_identities(Some(CASHIER));
        // Windows' default for a service: interactive users query it and read its rules.
        let default = [
            rule(SYSTEM, 0x2018D),
            rule(ADMINISTRATORS, 0xF01FF),
            rule(INTERACTIVE, 0x2018D),
        ];
        assert!(service_closed(&default, &who));
        for mask in [0x20, 0x40, 0x2, 0x10000, 0x40000, 0x80000, 0x1000_0000] {
            let mut open = default.to_vec();
            open.push(rule(USERS, mask));
            assert!(!service_closed(&open, &who), "{mask:#x}");
        }
        // Starting it is not stopping it.
        let mut start = default.to_vec();
        start.push(rule(INTERACTIVE, 0x10));
        assert!(service_closed(&start, &who));
    }

    #[test]
    fn the_folders_checked_include_the_backups_wherever_they_are() {
        let layout = Layout {
            data_dir: PathBuf::from("C:/ProgramData/ARTEPOOL"),
            program_dir: PathBuf::from("C:/Program Files/ARTEPOOL"),
        };
        let default = closed_folders(&layout, None);
        assert_eq!(default.len(), 8);
        assert!(default.contains(&PathBuf::from("C:/ProgramData/ARTEPOOL/backups")));
        assert!(default.contains(&PathBuf::from("C:/ProgramData/ARTEPOOL/updates")));
        assert!(default.contains(&PathBuf::from("C:/ProgramData/ARTEPOOL/secrets")));
        let elsewhere = backup_dir_from_settings(r#"{"backupDir":"D:\\Backups"}"#);
        assert!(closed_folders(&layout, elsewhere).contains(&PathBuf::from("D:\\Backups")));
        assert_eq!(backup_dir_from_settings(r#"{"version":1}"#), None);
        assert_eq!(backup_dir_from_settings("not json"), None);
    }

    #[test]
    fn folder_rules_are_given_by_sid() {
        let root = icacls_root(Path::new("C:/ProgramData/ARTEPOOL"));
        assert!(root.contains(&"/inheritance:r".to_string()));
        assert!(
            root.contains(&format!("*{USERS}:RX")),
            "read only, nothing passed down"
        );
        assert!(root.contains(&format!("*{SYSTEM}:(OI)(CI)F")));
        let device = icacls_device(Path::new("C:/ProgramData/ARTEPOOL/device"));
        assert!(device.contains(&format!("*{USERS}:(OI)(CI)M")));
        assert!(!device.iter().any(|a| a.contains(EVERYONE)));
        assert_eq!(
            icacls_reset(Path::new("C:/x"))[1..],
            ["/reset", "/T", "/C", "/Q"]
        );
    }

    #[test]
    fn the_password_is_long_random_and_mixed() {
        let a = generate_password().unwrap();
        let b = generate_password().unwrap();
        assert_ne!(a.as_str(), b.as_str());
        for _ in 0..200 {
            let p = generate_password().unwrap();
            assert!(strong_enough(&p), "{}", p.len());
            assert!(!p.contains(' ') && !p.contains('"') && !p.contains('\\'));
        }
        // Too short, and one kind of character only: built, not written as a literal.
        let short: String = generate_password().unwrap().chars().take(8).collect();
        assert!(!strong_enough(&short));
        assert!(!strong_enough(&"a".repeat(40)));
    }

    #[test]
    fn automatic_sign_in_never_holds_the_password() {
        let values = winlogon_values("SHOP-PC");
        assert!(values.contains(&("AutoAdminLogon", "1".into())));
        assert!(values.contains(&("DefaultUserName", ACCOUNT.into())));
        assert!(values.contains(&("DefaultDomainName", "SHOP-PC".into())));
        assert!(!values.iter().any(|(name, _)| *name == "DefaultPassword"));
        assert!(WINLOGON_REMOVED.contains(&"DefaultPassword"));
    }

    #[test]
    fn the_state_names_what_is_missing() {
        assert_eq!(state(&all_right()), "ok");
        assert_eq!(state(&Observed::default()), "not_set_up");
        assert_eq!(missing(&Observed::default()), ["account"]);
        let admin = Observed {
            in_administrators: true,
            ..all_right()
        };
        assert_eq!(state(&admin), "repair");
        assert_eq!(missing(&admin), ["standard"]);
        let broken = Observed {
            auto_sign_in: false,
            secret_stored: false,
            plain_password: true,
            enrollment_shared: false,
            open_folders: vec!["C:/ProgramData/ARTEPOOL/secrets".into()],
            open_services: vec!["ArtepoolServer".into()],
            active_hours: false,
            ..all_right()
        };
        assert_eq!(
            missing(&broken),
            [
                "auto_sign_in",
                "password_stored",
                "plain_password",
                "enrollment",
                "folders",
                "services",
                "active_hours"
            ]
        );
        let root_open = Observed {
            root_read_only: false,
            ..all_right()
        };
        assert_eq!(missing(&root_open), ["folders"]);
        let text = report(&broken).to_string();
        assert!(text.contains("\"state\":\"repair\""));
        assert!(text.contains("ArtepoolServer"));
    }
}
