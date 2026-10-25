//! "ARTÉPOOL – Emergency tool" (decision 0107): the window the owner opens from the Start menu of
//! the server PC, through Windows' administrator prompt, instead of typing console commands.
//!
//! Each action is the console's own program, started through the launcher with the protected
//! secrets:
//!
//!   artepool-svc.exe run emergency <action>     (input: one JSON object on standard input)
//!
//! Its answer is one JSON line on standard output. It may hold a temporary password, so it goes
//! to the window only: it is never logged or written anywhere.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::{Value, json};

/// The actions the window may ask for; anything else is refused before starting a program.
pub const ACTIONS: [&str; 3] = ["reset-password", "reset-2fa", "device-code"];

/// The three Windows services the installer registers (M6.2 part F).
pub const SERVICES: [(&str, &str); 3] = [
    ("database", "ArtepoolDatabase"),
    ("server", "ArtepoolServer"),
    ("backup", "ArtepoolBackup"),
];

/// Where the installation is: the launcher's folder and the data folder.
#[derive(Debug, Clone)]
pub struct Installation {
    pub program_dir: PathBuf,
    pub data_dir: PathBuf,
}

impl Installation {
    pub fn launcher(&self) -> PathBuf {
        self.program_dir.join("artepool-svc.exe")
    }
    pub fn config_file(&self) -> PathBuf {
        self.data_dir.join("config").join("server.json")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }
    /// The server PC has the launcher, the settings file and the protected secrets; any other
    /// PC has none of them.
    pub fn is_server_pc(&self) -> bool {
        self.launcher().is_file()
            && self.config_file().is_file()
            && self.data_dir.join("secrets").is_dir()
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ServiceState {
    Running,
    Stopped,
    Starting,
    Missing,
    Unknown,
}

/// Reads `sc.exe query <name>`: the `STATE : 4  RUNNING` line, or error 1060 (no such service).
pub fn parse_service_state(output: &str) -> ServiceState {
    if output.contains("1060") {
        return ServiceState::Missing;
    }
    let Some(line) = output.lines().find(|l| l.trim_start().starts_with("STATE")) else {
        return ServiceState::Unknown;
    };
    let code = line
        .split(':')
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|n| n.parse::<u32>().ok());
    match code {
        Some(4) => ServiceState::Running,
        Some(1) => ServiceState::Stopped,
        Some(2) | Some(7) => ServiceState::Starting,
        Some(_) => ServiceState::Stopped,
        None => ServiceState::Unknown,
    }
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(windows)]
pub fn service_state(name: &str) -> ServiceState {
    let system = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let sc = Path::new(&system).join("System32").join("sc.exe");
    match hidden(Command::new(sc).args(["query", name])).output() {
        Ok(out) => parse_service_state(&String::from_utf8_lossy(&out.stdout)),
        Err(_) => ServiceState::Unknown,
    }
}

#[cfg(not(windows))]
pub fn service_state(_name: &str) -> ServiceState {
    ServiceState::Unknown
}

/// The last JSON line a program wrote, if any.
pub fn last_json_line(output: &str) -> Option<Value> {
    output
        .lines()
        .rev()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .find_map(|l| {
            serde_json::from_str::<Value>(l)
                .ok()
                .filter(Value::is_object)
        })
}

fn failure(reason: &str, detail: Option<String>) -> Value {
    match detail {
        Some(detail) => json!({ "ok": false, "reason": reason, "detail": detail }),
        None => json!({ "ok": false, "reason": reason }),
    }
}

/// Starts `launcher run emergency <action>` with `input` on its standard input and returns its
/// answer (`{"ok": true, "result": …}` or `{"ok": false, "reason": …}`).
pub fn run_action(launcher: &Path, action: &str, input: &Value) -> Value {
    if action != "status" && !ACTIONS.contains(&action) {
        return failure("unknown_action", None);
    }
    let mut command = Command::new(launcher);
    command
        .args(["run", "emergency", action])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match hidden(&mut command).spawn() {
        Ok(child) => child,
        Err(error) => {
            return failure(
                "launch_failed",
                Some(format!("{}: {error}", launcher.display())),
            );
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.to_string().as_bytes());
        // Dropped here: end of input.
    }
    // Both outputs are read together, so a program that writes much to one never waits on us.
    let (out, errors) = match child.wait_with_output() {
        Ok(output) => (
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ),
        Err(error) => (String::new(), error.to_string()),
    };
    match last_json_line(&out) {
        Some(answer) if answer.get("ok").and_then(Value::as_bool).is_some() => answer,
        _ => failure(
            "launch_failed",
            Some(
                errors
                    .lines()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("The emergency program stopped without an answer.")
                    .to_string(),
            ),
        ),
    }
}

/// `artepool-svc secrets check`: whether the six protected secrets open (never their values).
pub fn secrets_ok(launcher: &Path) -> bool {
    hidden(Command::new(launcher).args(["secrets", "check"]))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// "Check the system": the services, the secrets and the database, each line green or red.
pub fn check(installation: &Installation, state_of: impl Fn(&str) -> ServiceState) -> Value {
    let services: serde_json::Map<String, Value> = SERVICES
        .iter()
        .map(|(key, name)| {
            (
                (*key).to_string(),
                serde_json::to_value(state_of(name)).unwrap_or(Value::Null),
            )
        })
        .collect();
    let launcher = installation.launcher();
    json!({
        "services": services,
        "secrets": secrets_ok(&launcher),
        "database": run_action(&launcher, "status", &json!({})),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("artepool-emergency-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_the_service_state_from_sc_query() {
        let running = "SERVICE_NAME: ArtepoolServer\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : 4  RUNNING\r\n";
        assert_eq!(parse_service_state(running), ServiceState::Running);
        let stopped = "        STATE              : 1  STOPPED\r\n";
        assert_eq!(parse_service_state(stopped), ServiceState::Stopped);
        let starting = "        STATE              : 2  START_PENDING\r\n";
        assert_eq!(parse_service_state(starting), ServiceState::Starting);
        let missing = "[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\r\n\r\nThe specified service does not exist as an installed service.\r\n";
        assert_eq!(parse_service_state(missing), ServiceState::Missing);
        assert_eq!(parse_service_state(""), ServiceState::Unknown);
    }

    #[test]
    fn takes_the_last_json_object_line() {
        assert_eq!(
            last_json_line("warning: x\n{\"ok\":true,\"result\":{}}\n\n"),
            Some(json!({ "ok": true, "result": {} }))
        );
        assert_eq!(last_json_line("[1,2]\nnot json"), None);
        assert_eq!(last_json_line(""), None);
    }

    #[test]
    fn is_the_server_pc_only_with_launcher_settings_and_secrets() {
        let root = temp_dir("pc");
        let installation = Installation {
            program_dir: root.join("program"),
            data_dir: root.join("data"),
        };
        assert!(!installation.is_server_pc());
        std::fs::create_dir_all(&installation.program_dir).unwrap();
        std::fs::write(installation.launcher(), b"exe").unwrap();
        std::fs::create_dir_all(installation.data_dir.join("config")).unwrap();
        std::fs::write(installation.config_file(), b"{}").unwrap();
        assert!(!installation.is_server_pc());
        std::fs::create_dir_all(installation.data_dir.join("secrets")).unwrap();
        assert!(installation.is_server_pc());
        assert_eq!(installation.logs_dir(), root.join("data").join("logs"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_an_unknown_action_without_starting_anything() {
        let answer = run_action(Path::new("/no/such/launcher"), "drop-all", &json!({}));
        assert_eq!(answer, json!({ "ok": false, "reason": "unknown_action" }));
        let answer = run_action(Path::new("/no/such/launcher"), "device-code", &json!({}));
        assert_eq!(answer["reason"], "launch_failed");
    }

    #[cfg(unix)]
    fn fake_launcher(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("artepool-svc.exe");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn runs_the_launcher_with_the_input_and_returns_its_answer() {
        let _turn = crate::restore::tests::SPAWNING
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("run");
        // Echoes its arguments and input back, as the answer.
        let launcher = fake_launcher(
            &dir,
            r#"input=$(cat)
if [ "$1" = "secrets" ]; then exit 0; fi
echo "starting"
printf '{"ok":true,"result":{"args":"%s","input":%s}}\n' "$*" "$input""#,
        );
        let answer = run_action(&launcher, "reset-2fa", &json!({ "reason": "phone lost" }));
        assert_eq!(
            answer,
            json!({ "ok": true, "result": {
                "args": "run emergency reset-2fa",
                "input": { "reason": "phone lost" }
            }})
        );
        assert!(secrets_ok(&launcher));

        let installation = Installation {
            program_dir: dir.clone(),
            data_dir: dir.join("data"),
        };
        let report = check(&installation, |name| {
            if name == "ArtepoolBackup" {
                ServiceState::Stopped
            } else {
                ServiceState::Running
            }
        });
        assert_eq!(
            report["services"],
            json!({ "database": "running", "server": "running", "backup": "stopped" })
        );
        assert_eq!(report["secrets"], true);
        assert_eq!(report["database"]["result"]["args"], "run emergency status");

        let silent = fake_launcher(&dir, "echo 'Could not open the secrets' >&2; exit 3");
        let answer = run_action(&silent, "device-code", &json!({}));
        assert_eq!(
            answer,
            json!({ "ok": false, "reason": "launch_failed", "detail": "Could not open the secrets" })
        );
        assert!(!secrets_ok(&silent));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
