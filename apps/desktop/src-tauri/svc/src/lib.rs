//! The ARTÉPOOL server's service launcher (decision 0103, M6.2 part B).
//!
//! The server PC keeps six secrets in `C:\ProgramData\ARTEPOOL\secrets`: the master key, the
//! passwords of the four database roles, and the PostgreSQL superuser's password (given only to the
//! restore program, never to the services). Each is a file protected by Windows DPAPI for the machine
//! (it opens only on this PC), bound to its own name, in a folder that only SYSTEM, Administrators
//! and the ARTÉPOOL services may open. The launcher:
//!
//! - `run <program> [args…]`: unlocks the secrets in memory and starts the bundled Node program
//!   with them in its environment (each program only the secrets it needs); nothing is ever written to disk in clear. The Windows services
//!   (WinSW) run the API and the backup service this way, and an administrator runs the console
//!   tools this way.
//! - `secrets init`: creates new random secrets (once, at installation).
//! - `secrets set <name>`: replaces one secret with a value read from the standard input (restore:
//!   the master key from the backup).
//! - `secrets check`: checks that every secret is there, opens, and is well protected. It never
//!   shows a value.
//!
//! It refuses to start when a secret is missing or does not open, or when the folder or a file
//! can be opened by anyone else.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

pub mod config;
#[cfg(windows)]
pub mod windows;

#[derive(Debug, thiserror::Error)]
pub enum SvcError {
    #[error(
        "The secret \"{0}\" is missing in {1}. Run: artepool-svc secrets init (installation) or restore it from the backup."
    )]
    Missing(&'static str, String),
    #[error("The secret \"{0}\" could not be opened on this PC: {1}")]
    Unprotect(&'static str, String),
    #[error("The secret \"{0}\" could not be protected: {1}")]
    Protect(&'static str, String),
    #[error("The secret \"{0}\" is not valid: {1}")]
    Invalid(&'static str, &'static str),
    #[error(
        "Secrets already exist in {0}; nothing was changed. Use \"secrets set\" to replace one."
    )]
    AlreadyExists(String),
    #[error(
        "{0} can be opened by {1}. Only SYSTEM, Administrators and the ARTÉPOOL services may open it."
    )]
    TooOpen(String, String),
    #[error("The access rules of {0} could not be read: {1}")]
    AccessUnknown(String, String),
    #[error(
        "Unknown secret \"{0}\". Known: master-key, migrator-password, api-password, backup-password, maint-password, pg-superuser-password."
    )]
    UnknownSecret(String),
    #[error("Unknown program \"{0}\". Known: {1}.")]
    UnknownProgram(String, String),
    #[error("{0}")]
    Io(String),
    #[error("This command works only on the Windows server PC.")]
    NotWindows,
}

/// What a secret holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretKind {
    /// 32 random bytes, given to the server as base64 (the SecretBox master key).
    Key32,
    /// A database role's password: printable ASCII, no spaces.
    Password,
}

#[derive(Clone, Copy, Debug)]
pub struct Secret {
    /// The name used on the command line and to bind the DPAPI blob.
    pub name: &'static str,
    /// The file in the secrets folder.
    pub file: &'static str,
    /// The environment variable the Node programs read.
    pub env: &'static str,
    pub kind: SecretKind,
    /// The only programs given this secret; `None`: every program.
    pub programs: Option<&'static [&'static str]>,
}

impl Secret {
    pub fn given_to(&self, program: &str) -> bool {
        self.programs
            .is_none_or(|programs| programs.contains(&program))
    }
}

pub const SECRETS: [Secret; 6] = [
    Secret {
        name: "master-key",
        file: "master-key.dpapi",
        env: "ARTEPOOL_MASTER_KEY",
        kind: SecretKind::Key32,
        programs: None,
    },
    Secret {
        name: "migrator-password",
        file: "migrator-password.dpapi",
        env: "ARTEPOOL_MIGRATOR_PASSWORD",
        kind: SecretKind::Password,
        programs: None,
    },
    Secret {
        name: "api-password",
        file: "api-password.dpapi",
        env: "ARTEPOOL_API_PASSWORD",
        kind: SecretKind::Password,
        programs: None,
    },
    Secret {
        name: "backup-password",
        file: "backup-password.dpapi",
        env: "ARTEPOOL_BACKUP_PASSWORD",
        kind: SecretKind::Password,
        programs: None,
    },
    Secret {
        name: "maint-password",
        file: "maint-password.dpapi",
        env: "ARTEPOOL_MAINT_PASSWORD",
        kind: SecretKind::Password,
        programs: None,
    },
    // The installation sets PostgreSQL's superuser password to this value. Only the installation
    // program, the restore from a backup and the upgrade need it (they create databases and roles,
    // or rename databases); the services never get it.
    Secret {
        name: "pg-superuser-password",
        file: "pg-superuser-password.dpapi",
        env: "PG_SUPERUSER_PASSWORD",
        kind: SecretKind::Password,
        programs: Some(&["install", "restore", "upgrade"]),
    },
];

/// The bundled programs `run` may start (`<name>.mjs` in the server folder).
pub const PROGRAMS: [&str; 12] = [
    "server",
    "backup",
    "migrate",
    "owner-create",
    "device-code",
    "owner-reset-2fa",
    "owner-reset-password",
    "restore",
    "install",
    "emergency",
    "upgrade",
    "delete-data",
];

pub fn secret_named(name: &str) -> Result<Secret, SvcError> {
    SECRETS
        .iter()
        .copied()
        .find(|s| s.name == name)
        .ok_or_else(|| SvcError::UnknownSecret(name.to_string()))
}

/// Seals and opens secrets (DPAPI on Windows; a fake in the tests).
pub trait Protector {
    fn protect(&self, secret: &Secret, plain: &[u8]) -> Result<Vec<u8>, String>;
    fn unprotect(&self, secret: &Secret, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String>;
}

/// Says who may open a file or folder; refuses anyone but SYSTEM, Administrators and the services.
pub trait AccessCheck {
    fn check(&self, path: &Path) -> Result<(), SvcError>;
}

/// DPAPI's optional entropy: each blob opens only as the secret it was made for.
pub fn entropy(secret: &Secret) -> Vec<u8> {
    format!("ARTEPOOL secrets v1/{}", secret.name).into_bytes()
}

/// Checks a value before it is stored or handed to the server.
pub fn validate(secret: &Secret, value: &[u8]) -> Result<(), SvcError> {
    match secret.kind {
        SecretKind::Key32 => {
            let text = std::str::from_utf8(value)
                .map_err(|_| SvcError::Invalid(secret.name, "not text"))?;
            let key = Zeroizing::new(
                STANDARD
                    .decode(text)
                    .map_err(|_| SvcError::Invalid(secret.name, "not base64"))?,
            );
            if key.len() != 32 {
                return Err(SvcError::Invalid(secret.name, "the key must be 32 bytes"));
            }
        }
        SecretKind::Password => {
            if value.len() < 16 {
                return Err(SvcError::Invalid(secret.name, "at least 16 characters"));
            }
            if !value.iter().all(|b| b.is_ascii_graphic()) {
                return Err(SvcError::Invalid(
                    secret.name,
                    "printable characters only, no spaces",
                ));
            }
        }
    }
    Ok(())
}

/// A new random value for a secret.
pub fn generate(secret: &Secret) -> Result<Zeroizing<Vec<u8>>, SvcError> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::fill(bytes.as_mut()).map_err(|e| SvcError::Io(format!("No random numbers: {e}")))?;
    let text = match secret.kind {
        SecretKind::Key32 => STANDARD.encode(bytes.as_ref()),
        SecretKind::Password => URL_SAFE_NO_PAD.encode(bytes.as_ref()),
    };
    Ok(Zeroizing::new(text.into_bytes()))
}

fn io(context: &str, error: std::io::Error) -> SvcError {
    SvcError::Io(format!("{context}: {error}"))
}

/// Writes through a temporary file and a rename, so a power cut never leaves half a secret.
fn write_sealed(dir: &Path, secret: &Secret, sealed: &[u8]) -> Result<(), SvcError> {
    let target = dir.join(secret.file);
    let temp = dir.join(format!("{}.new", secret.file));
    let mut file = fs::File::create(&temp).map_err(|e| io("Could not write the secret", e))?;
    file.write_all(sealed)
        .map_err(|e| io("Could not write the secret", e))?;
    file.sync_all()
        .map_err(|e| io("Could not write the secret", e))?;
    drop(file);
    fs::rename(&temp, &target).map_err(|e| io("Could not write the secret", e))
}

/// `secrets init`: the six secrets, new and random. Refuses if any already exists.
pub fn init(
    dir: &Path,
    protector: &dyn Protector,
    access: &dyn AccessCheck,
) -> Result<(), SvcError> {
    access.check(dir)?;
    if let Some(existing) = SECRETS.iter().find(|s| dir.join(s.file).exists()) {
        return Err(SvcError::AlreadyExists(format!(
            "{} ({})",
            dir.display(),
            existing.name
        )));
    }
    for secret in &SECRETS {
        let value = generate(secret)?;
        let sealed = protector
            .protect(secret, &value)
            .map_err(|e| SvcError::Protect(secret.name, e))?;
        write_sealed(dir, secret, &sealed)?;
    }
    Ok(())
}

/// `secrets set <name>`: replaces one secret (checked first) with `value`.
pub fn set(
    dir: &Path,
    secret: &Secret,
    value: &[u8],
    protector: &dyn Protector,
    access: &dyn AccessCheck,
) -> Result<(), SvcError> {
    access.check(dir)?;
    validate(secret, value)?;
    let sealed = protector
        .protect(secret, value)
        .map_err(|e| SvcError::Protect(secret.name, e))?;
    write_sealed(dir, secret, &sealed)
}

/// Every secret, opened and checked (`prepare` gives each program only its own).
pub fn load(
    dir: &Path,
    protector: &dyn Protector,
    access: &dyn AccessCheck,
) -> Result<Vec<(Secret, Zeroizing<String>)>, SvcError> {
    access.check(dir)?;
    let mut loaded = Vec::with_capacity(SECRETS.len());
    for secret in &SECRETS {
        let path = dir.join(secret.file);
        if !path.is_file() {
            return Err(SvcError::Missing(secret.name, dir.display().to_string()));
        }
        access.check(&path)?;
        let sealed = fs::read(&path).map_err(|e| io("Could not read the secret", e))?;
        let value = protector
            .unprotect(secret, &sealed)
            .map_err(|e| SvcError::Unprotect(secret.name, e))?;
        validate(secret, &value)?;
        let text = String::from_utf8(value.to_vec())
            .map_err(|_| SvcError::Invalid(secret.name, "not text"))?;
        loaded.push((*secret, Zeroizing::new(text)));
    }
    Ok(loaded)
}

/// Where the installed system keeps its files.
#[derive(Clone, Debug)]
pub struct Layout {
    /// `C:\ProgramData\ARTEPOOL`.
    pub data_dir: PathBuf,
    /// `C:\Program Files\ARTEPOOL` (the launcher's own folder).
    pub program_dir: PathBuf,
}

impl Layout {
    pub fn secrets_dir(&self) -> PathBuf {
        self.data_dir.join("secrets")
    }
    pub fn config_file(&self) -> PathBuf {
        self.data_dir.join("config").join("server.json")
    }
    pub fn node(&self) -> PathBuf {
        self.program_dir
            .join("node")
            .join(if cfg!(windows) { "node.exe" } else { "node" })
    }
    pub fn script(&self, program: &str) -> Result<PathBuf, SvcError> {
        if !PROGRAMS.contains(&program) {
            return Err(SvcError::UnknownProgram(
                program.to_string(),
                PROGRAMS.join(", "),
            ));
        }
        Ok(self
            .program_dir
            .join("server")
            .join(format!("{program}.mjs")))
    }
}

/// Settings a program must never inherit from whoever started the launcher: the launcher alone
/// gives the secrets, and development settings have no place on the installed server.
fn inherited(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    !(upper == "ARTEPOOL_MASTER_KEY"
        || upper == "ARTEPOOL_MASTER_KEY_FILE"
        || upper == "PGPASSWORD"
        || upper == "PG_SUPERUSER_PASSWORD"
        || upper == "NODE_OPTIONS"
        || upper == "ARTEPOOL_CONFIG"
        || upper == "ARTEPOOL_PROGRAM_DIR"
        || (upper.starts_with("ARTEPOOL_") && upper.ends_with("_PASSWORD")))
}

/// The program to start: node, the bundled script, and the environment (secrets included).
pub struct Launch {
    pub node: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, Zeroizing<String>)>,
}

pub fn prepare(
    layout: &Layout,
    program: &str,
    args: &[String],
    parent_env: impl IntoIterator<Item = (String, String)>,
    secrets: Vec<(Secret, Zeroizing<String>)>,
) -> Result<Launch, SvcError> {
    let script = layout.script(program)?;
    let mut env: Vec<(String, Zeroizing<String>)> = parent_env
        .into_iter()
        .filter(|(name, _)| inherited(name))
        .map(|(name, value)| (name, Zeroizing::new(value)))
        .collect();
    env.push((
        "ARTEPOOL_CONFIG".into(),
        Zeroizing::new(layout.config_file().display().to_string()),
    ));
    // The restore puts the copy's master key back through this launcher (`secrets set`).
    env.push((
        "ARTEPOOL_PROGRAM_DIR".into(),
        Zeroizing::new(layout.program_dir.display().to_string()),
    ));
    for (secret, value) in secrets {
        if secret.given_to(program) {
            env.push((secret.env.to_string(), value));
        }
    }
    let mut node_args = vec![script.display().to_string()];
    node_args.extend(args.iter().cloned());
    Ok(Launch {
        node: layout.node(),
        args: node_args,
        env,
    })
}

/// Starts the program and waits for it; its exit code becomes the launcher's.
pub fn spawn_and_wait(launch: Launch) -> Result<i32, SvcError> {
    let mut command = std::process::Command::new(&launch.node);
    command.args(&launch.args).env_clear();
    for (name, value) in &launch.env {
        command.env(name, value.as_str());
    }
    let status = command
        .status()
        .map_err(|e| io(&format!("Could not start {}", launch.node.display()), e))?;
    Ok(status.code().unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Stands in for DPAPI: the blob carries the entropy, so a blob made for one secret does not
    /// open as another (as with DPAPI's entropy).
    struct FakeDpapi;
    impl Protector for FakeDpapi {
        fn protect(&self, secret: &Secret, plain: &[u8]) -> Result<Vec<u8>, String> {
            let mut out = entropy(secret);
            out.push(0);
            out.extend(plain.iter().map(|b| b ^ 0x5a));
            Ok(out)
        }
        fn unprotect(&self, secret: &Secret, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            let tag = entropy(secret);
            if sealed.len() <= tag.len() || sealed[..tag.len()] != tag[..] || sealed[tag.len()] != 0
            {
                return Err("The data is invalid.".into());
            }
            Ok(Zeroizing::new(
                sealed[tag.len() + 1..].iter().map(|b| b ^ 0x5a).collect(),
            ))
        }
    }

    /// Refuses the paths it is told to refuse, and records what was checked.
    #[derive(Default)]
    struct FakeAccess {
        open: Vec<PathBuf>,
        checked: RefCell<Vec<PathBuf>>,
    }
    impl AccessCheck for FakeAccess {
        fn check(&self, path: &Path) -> Result<(), SvcError> {
            self.checked.borrow_mut().push(path.to_path_buf());
            if self.open.iter().any(|p| p == path) {
                return Err(SvcError::TooOpen(
                    path.display().to_string(),
                    "BUILTIN\\Users".into(),
                ));
            }
            Ok(())
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("artepool-svc-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn init_creates_six_sealed_secrets_that_load_and_never_lie_in_clear() {
        let dir = temp_dir("init");
        init(&dir, &FakeDpapi, &FakeAccess::default()).unwrap();
        let loaded = load(&dir, &FakeDpapi, &FakeAccess::default()).unwrap();
        let names: Vec<_> = loaded.iter().map(|(s, _)| s.env).collect();
        assert_eq!(
            names,
            [
                "ARTEPOOL_MASTER_KEY",
                "ARTEPOOL_MIGRATOR_PASSWORD",
                "ARTEPOOL_API_PASSWORD",
                "ARTEPOOL_BACKUP_PASSWORD",
                "ARTEPOOL_MAINT_PASSWORD",
                "PG_SUPERUSER_PASSWORD"
            ]
        );
        assert_eq!(STANDARD.decode(loaded[0].1.as_str()).unwrap().len(), 32);
        for (_, value) in &loaded[1..] {
            assert_eq!(value.len(), 43);
        }
        // Every password is different, and none is in a file as it is.
        for (i, secret) in SECRETS.iter().enumerate() {
            let on_disk = fs::read(dir.join(secret.file)).unwrap();
            let clear = loaded[i].1.as_bytes();
            assert!(
                !on_disk.windows(clear.len()).any(|w| w == clear),
                "{} in clear",
                secret.name
            );
        }
        assert_ne!(loaded[1].1, loaded[2].1);
        // A second init changes nothing.
        let err = init(&dir, &FakeDpapi, &FakeAccess::default()).unwrap_err();
        assert!(matches!(err, SvcError::AlreadyExists(_)));
        assert_eq!(
            load(&dir, &FakeDpapi, &FakeAccess::default()).unwrap()[0].1,
            loaded[0].1
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_to_start_when_a_secret_is_missing_or_belongs_to_another_name() {
        let dir = temp_dir("missing");
        init(&dir, &FakeDpapi, &FakeAccess::default()).unwrap();
        fs::remove_file(dir.join("backup-password.dpapi")).unwrap();
        let err = load(&dir, &FakeDpapi, &FakeAccess::default()).unwrap_err();
        assert!(
            matches!(err, SvcError::Missing("backup-password", _)),
            "{err}"
        );

        // The API password's file copied over the backup's: it does not open as the backup's.
        fs::copy(
            dir.join("api-password.dpapi"),
            dir.join("backup-password.dpapi"),
        )
        .unwrap();
        let err = load(&dir, &FakeDpapi, &FakeAccess::default()).unwrap_err();
        assert!(
            matches!(err, SvcError::Unprotect("backup-password", _)),
            "{err}"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_to_start_when_the_folder_or_a_file_is_too_open() {
        let dir = temp_dir("open");
        init(&dir, &FakeDpapi, &FakeAccess::default()).unwrap();
        let folder = FakeAccess {
            open: vec![dir.clone()],
            ..Default::default()
        };
        assert!(matches!(
            load(&dir, &FakeDpapi, &folder).unwrap_err(),
            SvcError::TooOpen(..)
        ));
        let file = FakeAccess {
            open: vec![dir.join("maint-password.dpapi")],
            ..Default::default()
        };
        assert!(matches!(
            load(&dir, &FakeDpapi, &file).unwrap_err(),
            SvcError::TooOpen(..)
        ));
        // Every file was checked, not only the folder.
        let all = FakeAccess::default();
        load(&dir, &FakeDpapi, &all).unwrap();
        assert_eq!(all.checked.borrow().len(), 1 + SECRETS.len());
        // Nothing is created in a folder that is too open.
        let empty = temp_dir("open-init");
        let refuse = FakeAccess {
            open: vec![empty.clone()],
            ..Default::default()
        };
        assert!(init(&empty, &FakeDpapi, &refuse).is_err());
        assert_eq!(fs::read_dir(&empty).unwrap().count(), 0);
        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(empty).unwrap();
    }

    #[test]
    fn set_replaces_one_secret_after_checking_it() {
        let dir = temp_dir("set");
        init(&dir, &FakeDpapi, &FakeAccess::default()).unwrap();
        let key = STANDARD.encode([7u8; 32]);
        let master = secret_named("master-key").unwrap();
        set(
            &dir,
            &master,
            key.as_bytes(),
            &FakeDpapi,
            &FakeAccess::default(),
        )
        .unwrap();
        assert_eq!(
            load(&dir, &FakeDpapi, &FakeAccess::default()).unwrap()[0]
                .1
                .as_str(),
            key
        );

        let short = STANDARD.encode([7u8; 16]);
        assert!(matches!(
            set(
                &dir,
                &master,
                short.as_bytes(),
                &FakeDpapi,
                &FakeAccess::default()
            )
            .unwrap_err(),
            SvcError::Invalid("master-key", _)
        ));
        let api = secret_named("api-password").unwrap();
        assert!(
            set(
                &dir,
                &api,
                b"has a space in it!!",
                &FakeDpapi,
                &FakeAccess::default()
            )
            .is_err()
        );
        assert!(set(&dir, &api, b"short", &FakeDpapi, &FakeAccess::default()).is_err());
        assert!(matches!(
            secret_named("root").unwrap_err(),
            SvcError::UnknownSecret(_)
        ));
        // No temporary file is left behind.
        assert!(
            fs::read_dir(&dir).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".new"))
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_program_gets_the_settings_file_and_the_secrets_but_nothing_planted_by_the_caller() {
        let layout = Layout {
            data_dir: PathBuf::from("/pd/ARTEPOOL"),
            program_dir: PathBuf::from("/pf/ARTEPOOL"),
        };
        let parent = vec![
            ("PATH".to_string(), "/bin".to_string()),
            ("SystemRoot".to_string(), "C:\\Windows".to_string()),
            ("ARTEPOOL_API_PASSWORD".to_string(), "planted".to_string()),
            ("artepool_master_key".to_string(), "planted".to_string()),
            ("ARTEPOOL_MASTER_KEY_FILE".to_string(), "/tmp/k".to_string()),
            ("ARTEPOOL_CONFIG".to_string(), "/tmp/other.json".to_string()),
            (
                "NODE_OPTIONS".to_string(),
                "--require /tmp/evil.js".to_string(),
            ),
            ("PGPASSWORD".to_string(), "planted".to_string()),
            ("ARTEPOOL_PROGRAM_DIR".to_string(), "/tmp/evil".to_string()),
            ("PG_SUPERUSER_PASSWORD".to_string(), "planted".to_string()),
        ];
        let secrets = || {
            vec![
                (
                    secret_named("api-password").unwrap(),
                    Zeroizing::new("real".to_string()),
                ),
                (
                    secret_named("pg-superuser-password").unwrap(),
                    Zeroizing::new("superuser".to_string()),
                ),
            ]
        };
        let launch = prepare(
            &layout,
            "migrate",
            &["up".to_string()],
            parent.clone(),
            secrets(),
        )
        .unwrap();
        assert_eq!(launch.node, layout.node());
        assert_eq!(
            launch.args,
            [
                layout
                    .program_dir
                    .join("server")
                    .join("migrate.mjs")
                    .display()
                    .to_string(),
                "up".into()
            ]
        );
        let env: Vec<(String, String)> = launch
            .env
            .iter()
            .map(|(n, v)| (n.clone(), v.to_string()))
            .collect();
        assert_eq!(
            env,
            [
                ("PATH".into(), "/bin".into()),
                ("SystemRoot".into(), "C:\\Windows".into()),
                (
                    "ARTEPOOL_CONFIG".into(),
                    layout.config_file().display().to_string()
                ),
                ("ARTEPOOL_PROGRAM_DIR".into(), "/pf/ARTEPOOL".into()),
                ("ARTEPOOL_API_PASSWORD".into(), "real".into()),
            ]
        );
        // The superuser's password goes to the restore alone.
        let restore = prepare(&layout, "restore", &[], parent, secrets()).unwrap();
        let names: Vec<&str> = restore.env.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "PATH",
                "SystemRoot",
                "ARTEPOOL_CONFIG",
                "ARTEPOOL_PROGRAM_DIR",
                "ARTEPOOL_API_PASSWORD",
                "PG_SUPERUSER_PASSWORD"
            ]
        );
        assert_eq!(restore.env[5].1.as_str(), "superuser");
        assert!(matches!(
            prepare(&layout, "../evil", &[], Vec::new(), Vec::new()).err(),
            Some(SvcError::UnknownProgram(..))
        ));
    }
}
