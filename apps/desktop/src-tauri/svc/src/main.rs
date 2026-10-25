//! `artepool-svc` — the server's service launcher (see the library for what each command does).
//!
//!   artepool-svc run <program> [args…]   start a bundled program with the secrets
//!   artepool-svc secrets init            new secrets (installation)
//!   artepool-svc secrets set <name>      replace one secret, value read from the standard input
//!   artepool-svc secrets check           every secret present, opening, well protected
//!
//! `--data <folder>` (before the command) replaces `C:\ProgramData\ARTEPOOL`.

use std::process::ExitCode;

const USAGE: &str = "Usage:
  artepool-svc [--data <folder>] run <program> [args...]
  artepool-svc [--data <folder>] secrets init
  artepool-svc [--data <folder>] secrets set <name>   (the value is read from the standard input)
  artepool-svc [--data <folder>] secrets check";

#[cfg(windows)]
fn main() -> ExitCode {
    use artepool_svc::windows::{Dpapi, WindowsAccess, create_private_dir, default_data_dir};
    use artepool_svc::{
        Layout, SECRETS, SvcError, init, load, prepare, secret_named, set, spawn_and_wait,
    };
    use std::io::Read;
    use std::path::PathBuf;

    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut data_dir = default_data_dir();
    if args.first().map(String::as_str) == Some("--data") {
        if args.len() < 2 {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
        data_dir = PathBuf::from(args.remove(1));
        args.remove(0);
    }
    let program_dir = match std::env::current_exe() {
        Ok(exe) => exe.parent().map(PathBuf::from).unwrap_or_default(),
        Err(error) => {
            eprintln!("Could not find the launcher's folder: {error}");
            return ExitCode::FAILURE;
        }
    };
    let layout = Layout {
        data_dir,
        program_dir,
    };
    let secrets_dir = layout.secrets_dir();

    let result: Result<i32, SvcError> = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["run", program, rest @ ..] => {
            load(&secrets_dir, &Dpapi, &WindowsAccess).and_then(|secrets| {
                let rest: Vec<String> = rest.iter().map(|s| s.to_string()).collect();
                prepare(&layout, program, &rest, std::env::vars(), secrets).and_then(spawn_and_wait)
            })
        }
        ["secrets", "init"] => {
            let created = if secrets_dir.exists() {
                Ok(())
            } else {
                create_private_dir(&secrets_dir)
            };
            created
                .and_then(|()| init(&secrets_dir, &Dpapi, &WindowsAccess))
                .map(|()| {
                    println!(
                        "{} secrets created in {} (protected for this PC).",
                        SECRETS.len(),
                        secrets_dir.display()
                    );
                    0
                })
        }
        ["secrets", "set", name] => secret_named(name).and_then(|secret| {
            let mut value = zeroize::Zeroizing::new(String::new());
            std::io::stdin()
                .read_to_string(&mut value)
                .map_err(|e| SvcError::Io(format!("Could not read the value: {e}")))?;
            set(
                &secrets_dir,
                &secret,
                value.trim().as_bytes(),
                &Dpapi,
                &WindowsAccess,
            )?;
            println!("The secret \"{}\" was replaced.", secret.name);
            Ok(0)
        }),
        ["secrets", "check"] => load(&secrets_dir, &Dpapi, &WindowsAccess).map(|loaded| {
            println!(
                "OK: {} secrets present, opening on this PC, and well protected.",
                loaded.len()
            );
            0
        }),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(windows))]
fn main() -> ExitCode {
    eprintln!("{}\n{USAGE}", artepool_svc::SvcError::NotWindows);
    ExitCode::FAILURE
}
