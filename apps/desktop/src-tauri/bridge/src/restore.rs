//! Restore from a backup on a new server PC (decision 0102, M6.2 part E). The wizard, which runs
//! as a Windows administrator (only administrators can read the installer's setup token), finds
//! the backup copies in the usual places and starts the restore program through the launcher:
//!
//!   artepool-svc.exe run restore <copy>
//!
//! The owner's private key goes to it on its standard input only (never on a command line, never
//! in a file). The program reports its steps and its result as JSON lines on its standard output;
//! this side keeps the latest of each for the screens to ask about.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// The folder a USB stick's copies are in (the external-drive copies, decision 0086).
pub const DRIVE_FOLDER: &str = "ARTEPOOL-BACKUPS";
/// At most this many copies are listed, the newest first.
pub const MAX_LISTED: usize = 50;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Place {
    Removable,
    Downloads,
    Desktop,
    Documents,
    Backups,
    Typed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreCopy {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub modified_at: String,
    pub place: Place,
    pub encrypted: bool,
}

/// `….dump` or `….dump.age`, any case.
pub fn is_copy_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".dump") || lower.ends_with(".dump.age")
}

/// The owner's age private key: `AGE-SECRET-KEY-1` and 58 characters (bech32, upper case).
pub fn is_private_key(key: &str) -> bool {
    key.len() == 74
        && key.starts_with("AGE-SECRET-KEY-1")
        && key[16..]
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_uppercase())
}

/// One file, if it is a backup copy.
pub fn copy_at(path: &Path, place: Place) -> Option<RestoreCopy> {
    let name = path.file_name()?.to_str()?.to_string();
    if !is_copy_name(&name) {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified_at = meta
        .modified()
        .ok()
        .and_then(|t| OffsetDateTime::from(t).format(&Rfc3339).ok())
        .unwrap_or_default();
    Some(RestoreCopy {
        path: path.display().to_string(),
        encrypted: name.to_ascii_lowercase().ends_with(".age"),
        name,
        bytes: meta.len(),
        modified_at,
        place,
    })
}

/// The copies in these folders (and their `ARTEPOOL-BACKUPS` folder), the newest first.
pub fn find_copies(places: &[(PathBuf, Place)]) -> Vec<RestoreCopy> {
    let mut found: Vec<RestoreCopy> = Vec::new();
    for (dir, place) in places {
        for folder in [dir.clone(), dir.join(DRIVE_FOLDER)] {
            let Ok(entries) = std::fs::read_dir(&folder) else {
                continue;
            };
            for entry in entries.flatten() {
                if let Some(copy) = copy_at(&entry.path(), *place) {
                    if !found.iter().any(|c| c.path == copy.path) {
                        found.push(copy);
                    }
                }
            }
        }
    }
    found.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    found.truncate(MAX_LISTED);
    found
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStart {
    pub path: String,
    pub private_key: String,
}

/// What the screens see: whether the restore runs, its step, and its result once done.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct RestoreStatus {
    pub running: bool,
    pub step: Option<String>,
    pub result: Option<Value>,
}

/// One restore at a time, for the whole app.
#[derive(Clone, Default)]
pub struct RestoreRun(Arc<Mutex<RestoreStatus>>);

fn failure(reason: &str, detail: Option<String>) -> Value {
    match detail {
        Some(detail) => json!({ "ok": false, "reason": reason, "detail": detail }),
        None => json!({ "ok": false, "reason": reason }),
    }
}

impl RestoreRun {
    pub fn status(&self) -> RestoreStatus {
        self.0.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn update(&self, change: impl FnOnce(&mut RestoreStatus)) {
        if let Ok(mut status) = self.0.lock() {
            change(&mut status);
        }
    }

    /// Reads the program's JSON lines: `{"step": …}` and finally `{"result": {"ok": …}}`.
    fn read_line(&self, line: &str) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if let Some(step) = message.get("step").and_then(Value::as_str) {
            let step = step.to_string();
            self.update(|s| s.step = Some(step));
        } else if let Some(result) = message.get("result") {
            if result.get("ok").and_then(Value::as_bool).is_some() {
                let result = result.clone();
                self.update(|s| s.result = Some(result));
            }
        }
    }

    /// Starts `launcher run restore <copy>` with the key on its standard input. Returns the
    /// failure reason when it cannot start; the result arrives later in `status()`.
    pub fn start(&self, launcher: &Path, request: &RestoreStart) -> Result<(), &'static str> {
        if !is_copy_name(&request.path) {
            return Err("not_a_copy");
        }
        if !request.private_key.is_empty() && !is_private_key(&request.private_key) {
            return Err("wrong_key");
        }
        {
            let Ok(mut status) = self.0.lock() else {
                return Err("busy");
            };
            if status.running {
                return Err("busy");
            }
            *status = RestoreStatus {
                running: true,
                step: None,
                result: None,
            };
        }
        let mut command = Command::new(launcher);
        command
            .args(["run", "restore", &request.path])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let detail = format!("{}: {error}", launcher.display());
                self.update(|s| {
                    s.running = false;
                    s.result = Some(failure("launch_failed", Some(detail)));
                });
                return Ok(());
            }
        };
        // The key, then end of input: a plain copy gets an empty line.
        let mut key = request.private_key.clone();
        key.push('\n');
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(key.as_bytes());
        }
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let run = self.clone();
        std::thread::spawn(move || {
            if let Some(stdout) = stdout {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    run.read_line(&line);
                }
            }
            let mut errors = String::new();
            if let Some(mut stderr) = stderr {
                let _ = stderr.read_to_string(&mut errors);
            }
            let _ = child.wait();
            run.update(|s| {
                s.running = false;
                if s.result.is_none() {
                    let last = errors.lines().rev().find(|l| !l.trim().is_empty());
                    s.result = Some(failure(
                        "launch_failed",
                        Some(
                            last.unwrap_or("The restore program stopped without a result.")
                                .to_string(),
                        ),
                    ));
                }
            });
        });
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("artepool-restore-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const KEY: &str = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";

    #[test]
    fn knows_copy_names_and_private_keys() {
        assert!(is_copy_name("artepool-20261019-100000Z.dump"));
        assert!(is_copy_name("ARTEPOOL-20261019-100000Z.DUMP.AGE"));
        assert!(!is_copy_name("photo.jpg"));
        assert!(!is_copy_name("artepool.dump.age.txt"));
        assert!(is_private_key(KEY));
        assert!(!is_private_key(&KEY.to_lowercase()));
        assert!(!is_private_key(&KEY[..73]));
        assert!(!is_private_key("age1publickeynotasecret"));
    }

    #[test]
    fn finds_copies_in_the_folders_and_their_backups_folder_newest_first() {
        let usb = temp_dir("usb");
        let downloads = temp_dir("downloads");
        std::fs::create_dir_all(usb.join(DRIVE_FOLDER)).unwrap();
        std::fs::write(usb.join(DRIVE_FOLDER).join("artepool-1.dump"), b"PGDMP").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(downloads.join("artepool-2.dump.age"), b"age").unwrap();
        std::fs::write(downloads.join("notes.txt"), b"x").unwrap();
        std::fs::create_dir_all(downloads.join("folder.dump")).unwrap();

        let found = find_copies(&[
            (usb.clone(), Place::Removable),
            (downloads.clone(), Place::Downloads),
            (PathBuf::from("/no/such/folder"), Place::Desktop),
        ]);
        let names: Vec<_> = found.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["artepool-2.dump.age", "artepool-1.dump"]);
        assert!(found[0].encrypted);
        assert_eq!(found[0].place, Place::Downloads);
        assert_eq!(found[1].place, Place::Removable);
        assert_eq!(found[1].bytes, 5);
        assert!(!found[1].encrypted);
        assert!(copy_at(&downloads.join("notes.txt"), Place::Typed).is_none());
        std::fs::remove_dir_all(usb).unwrap();
        std::fs::remove_dir_all(downloads).unwrap();
    }

    /// Writing a script while another test thread starts a process can make running it fail
    /// ("text file busy"): the tests that start the fake launcher take turns.
    #[cfg(unix)]
    pub(crate) static SPAWNING: Mutex<()> = Mutex::new(());

    #[cfg(unix)]
    fn fake_launcher(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("artepool-svc");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    fn wait(run: &RestoreRun) -> RestoreStatus {
        for _ in 0..200 {
            let status = run.status();
            if !status.running {
                return status;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("the restore did not finish");
    }

    #[cfg(unix)]
    #[test]
    fn runs_the_launcher_with_the_key_on_its_input_and_keeps_the_steps_and_result() {
        let _turn = SPAWNING.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("run");
        let seen = dir.join("seen");
        let launcher = fake_launcher(
            &dir,
            &format!(
                "read key; echo \"$1 $2 $3 $key\" > '{}'\n\
                 echo '{{\"step\":\"opening\"}}'\n\
                 echo 'some noise'\n\
                 echo '{{\"step\":\"checking\"}}'\n\
                 echo '{{\"result\":{{\"ok\":true,\"revokedDevices\":2}}}}'",
                seen.display()
            ),
        );
        let run = RestoreRun::default();
        run.start(
            &launcher,
            &RestoreStart {
                path: "/media/usb/artepool-1.dump.age".into(),
                private_key: KEY.into(),
            },
        )
        .unwrap();
        let status = wait(&run);
        assert_eq!(status.step.as_deref(), Some("checking"));
        assert_eq!(
            status.result,
            Some(json!({ "ok": true, "revokedDevices": 2 }))
        );
        // The key reached the program's input; the command line holds only the copy's path.
        assert_eq!(
            std::fs::read_to_string(&seen).unwrap().trim(),
            format!("run restore /media/usb/artepool-1.dump.age {KEY}")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_program_that_stops_without_a_result_or_cannot_start_is_a_failure() {
        let _turn = SPAWNING.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("fail");
        let launcher = fake_launcher(&dir, "echo 'The secret is missing' >&2\nexit 1");
        let run = RestoreRun::default();
        let request = RestoreStart {
            path: "/x/artepool-1.dump".into(),
            private_key: String::new(),
        };
        run.start(&launcher, &request).unwrap();
        assert_eq!(
            wait(&run).result,
            Some(
                json!({ "ok": false, "reason": "launch_failed", "detail": "The secret is missing" })
            )
        );
        run.start(&dir.join("missing"), &request).unwrap();
        let status = run.status();
        assert!(!status.running);
        assert_eq!(status.result.unwrap()["reason"], "launch_failed");
        // Bad input never starts anything.
        let bad_key = RestoreStart {
            path: "/x/artepool-1.dump.age".into(),
            private_key: "not a key".into(),
        };
        assert_eq!(run.start(&launcher, &bad_key), Err("wrong_key"));
        let not_copy = RestoreStart {
            path: "/x/photo.jpg".into(),
            private_key: String::new(),
        };
        assert_eq!(run.start(&launcher, &not_copy), Err("not_a_copy"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn one_restore_at_a_time() {
        let _turn = SPAWNING.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir("busy");
        let launcher = fake_launcher(
            &dir,
            "read key; sleep 1; echo '{\"result\":{\"ok\":false,\"reason\":\"wrong_key\"}}'",
        );
        let run = RestoreRun::default();
        let request = RestoreStart {
            path: "/x/artepool-1.dump".into(),
            private_key: String::new(),
        };
        run.start(&launcher, &request).unwrap();
        assert_eq!(run.start(&launcher, &request), Err("busy"));
        assert_eq!(wait(&run).result.unwrap()["reason"], "wrong_key");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
