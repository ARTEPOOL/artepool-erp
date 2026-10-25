//! `config init`: the installed server's settings file, `C:\ProgramData\ARTEPOOL\config\server.json`
//! (decision 0103, M6.2 part F). It holds no secret (the Node programs refuse one there); the
//! secrets stay in the DPAPI store. Written once, at installation; an existing file is never
//! replaced (an upgrade keeps it, Part G).

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::{Layout, SvcError};

/// What the installer chooses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigChoice {
    pub server_port: u16,
    pub database_port: u16,
}

impl Default for ConfigChoice {
    fn default() -> Self {
        Self {
            server_port: 3100,
            database_port: 5432,
        }
    }
}

/// The app's registration at Google (decision 0095), shipped next to the launcher as
/// `google.json` when the publisher built the installer with it; not secret.
fn google_clients(program_dir: &Path) -> Result<Option<Value>, SvcError> {
    let file = program_dir.join("google.json");
    let Ok(text) = fs::read_to_string(&file) else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| SvcError::Io(format!("{} is not valid JSON: {e}", file.display())))?;
    let valid_client = |v: &Value| {
        v.as_object().is_some_and(|o| {
            o.len() == 2
                && ["clientId", "clientSecret"].iter().all(|k| {
                    o.get(*k)
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
                })
        })
    };
    let object = value.as_object().filter(|o| {
        !o.is_empty()
            && o.iter()
                .all(|(k, v)| matches!(k.as_str(), "desktop" | "device") && valid_client(v))
    });
    match object {
        Some(_) => Ok(Some(value)),
        None => Err(SvcError::Io(format!(
            "{} must hold \"desktop\" and/or \"device\", each with clientId and clientSecret.",
            file.display()
        ))),
    }
}

/// The settings file's content for this installation.
pub fn settings(layout: &Layout, choice: &ConfigChoice) -> Result<Value, SvcError> {
    let path = |p: PathBuf| p.display().to_string();
    let mut config = Map::new();
    config.insert("version".into(), json!(1));
    config.insert("dataDir".into(), json!(path(layout.data_dir.clone())));
    config.insert(
        "server".into(),
        json!({ "host": "0.0.0.0", "port": choice.server_port }),
    );
    config.insert(
        "database".into(),
        json!({
            "host": "localhost",
            "port": choice.database_port,
            "name": "artepool",
            "superuser": "postgres",
        }),
    );
    config.insert(
        "pgBin".into(),
        json!(path(layout.program_dir.join("pgsql").join("bin"))),
    );
    config.insert("logLevel".into(), json!("info"));
    if let Some(google) = google_clients(&layout.program_dir)? {
        config.insert("google".into(), google);
    }
    Ok(Value::Object(config))
}

/// Writes the settings file if there is none; returns false (and changes nothing) if one exists.
pub fn init(layout: &Layout, choice: &ConfigChoice) -> Result<bool, SvcError> {
    let file = layout.config_file();
    if file.exists() {
        return Ok(false);
    }
    let content = serde_json::to_string_pretty(&settings(layout, choice)?)
        .map_err(|e| SvcError::Io(format!("Could not write the settings: {e}")))?;
    let dir = file.parent().unwrap_or(&layout.data_dir);
    fs::create_dir_all(dir)
        .map_err(|e| SvcError::Io(format!("Could not create {}: {e}", dir.display())))?;
    fs::write(&file, format!("{content}\n"))
        .map_err(|e| SvcError::Io(format!("Could not write {}: {e}", file.display())))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(name: &str) -> Layout {
        let root =
            std::env::temp_dir().join(format!("artepool-config-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("pf")).unwrap();
        Layout {
            data_dir: root.join("pd"),
            program_dir: root.join("pf"),
        }
    }

    #[test]
    fn writes_the_settings_once_and_never_replaces_them() {
        let layout = layout("once");
        assert!(init(&layout, &ConfigChoice::default()).unwrap());
        let written: Value =
            serde_json::from_str(&fs::read_to_string(layout.config_file()).unwrap()).unwrap();
        assert_eq!(written["version"], 1);
        assert_eq!(
            written["server"],
            json!({ "host": "0.0.0.0", "port": 3100 })
        );
        assert_eq!(written["database"]["name"], "artepool");
        assert_eq!(
            written["pgBin"],
            layout
                .program_dir
                .join("pgsql")
                .join("bin")
                .display()
                .to_string()
        );
        assert_eq!(written.get("google"), None);
        // No secret is ever in it.
        let text = fs::read_to_string(layout.config_file()).unwrap();
        assert!(!text.to_lowercase().contains("password"));

        let other = ConfigChoice {
            server_port: 4000,
            database_port: 5433,
        };
        assert!(!init(&layout, &other).unwrap());
        let again: Value =
            serde_json::from_str(&fs::read_to_string(layout.config_file()).unwrap()).unwrap();
        assert_eq!(again["server"]["port"], 3100);
    }

    #[test]
    fn the_google_registration_is_taken_from_the_installation_when_present() {
        let layout = layout("google");
        fs::write(
            layout.program_dir.join("google.json"),
            r#"{"desktop":{"clientId":"id.apps.googleusercontent.com","clientSecret":"not-secret"}}"#,
        )
        .unwrap();
        let config = settings(&layout, &ConfigChoice::default()).unwrap();
        assert_eq!(
            config["google"]["desktop"]["clientId"],
            "id.apps.googleusercontent.com"
        );
        fs::write(
            layout.program_dir.join("google.json"),
            r#"{"desktop":{"clientId":"x","password":"y"}}"#,
        )
        .unwrap();
        assert!(settings(&layout, &ConfigChoice::default()).is_err());
    }
}
