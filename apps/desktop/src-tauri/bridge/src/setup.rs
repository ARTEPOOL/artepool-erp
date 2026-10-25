//! The first-run wizard's channel (decision 0102, M6.2 part D). Right after installation the
//! server PC holds, in `C:\ProgramData\ARTEPOOL`, the installer's one-time setup token and the
//! ARTÉPOOL CA certificate (`setup\token`, `setup\ca.crt`, readable by administrators only) and the
//! settings file (`config\server.json`). This side reads them, and sends only setup steps, with the
//! token, to this PC's own server over TLS 1.3 trusting only that CA. The token never reaches the
//! screens. When setup completes the server deletes the token, and this channel goes quiet.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::connection::{self, ConnectionError, Request};
use crate::{BridgeError, BridgeResponse, parse_body, tls};

/// What the screens learn: whether the wizard may open here, and the server it talks to.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetupInfo {
    pub available: bool,
    pub server_address: Option<String>,
    /// This PC's Windows build (decision 0106): below 22000 is Windows 10 (a warning, never a block).
    pub windows_build: Option<u32>,
}

/// One setup step from the screens.
#[derive(Debug, Clone, Deserialize)]
pub struct SetupRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Option<Value>,
}

/// The installer's files, read when needed (never kept: the token disappears at the end).
#[derive(Clone)]
pub struct SetupAccess {
    pub server_address: String,
    pub ca_certificate_pem: String,
    token: String,
}

impl std::fmt::Debug for SetupAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SetupAccess")
            .field("server_address", &self.server_address)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct ServerSettings {
    server: ServerPort,
}

#[derive(Deserialize)]
struct ServerPort {
    port: u16,
}

/// The token the installer writes: 32 random bytes, base64url (43 characters).
pub fn is_setup_token(token: &str) -> bool {
    token.len() == 43
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Only the setup endpoints: `/api/v1/setup/…`, lower-case letters, digits, `-` and `/`.
pub fn is_setup_path(path: &str) -> bool {
    path.len() <= 128
        && path.strip_prefix("/api/v1/setup/").is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '/'))
                && !rest
                    .split('/')
                    .any(|segment| segment.is_empty() || segment == "..")
        })
}

impl SetupAccess {
    /// Reads the installer's files under the data folder; `None` when any is missing or wrong
    /// (a normal PC, a user who is not an administrator, or setup already complete).
    pub fn from_data_dir(data_dir: &Path) -> Option<Self> {
        let token = std::fs::read_to_string(data_dir.join("setup").join("token")).ok()?;
        let token = token.trim().to_string();
        if !is_setup_token(&token) {
            return None;
        }
        let ca_certificate_pem =
            std::fs::read_to_string(data_dir.join("setup").join("ca.crt")).ok()?;
        if !ca_certificate_pem.contains("BEGIN CERTIFICATE") {
            return None;
        }
        let settings: ServerSettings = serde_json::from_slice(
            &std::fs::read(data_dir.join("config").join("server.json")).ok()?,
        )
        .ok()?;
        Some(Self {
            // The server PC talks to its own server: no name lookup, no network needed.
            server_address: format!("127.0.0.1:{}", settings.server.port),
            ca_certificate_pem,
            token,
        })
    }

    pub fn info(access: Option<&Self>, windows_build: Option<u32>) -> SetupInfo {
        SetupInfo {
            available: access.is_some(),
            server_address: access.map(|a| a.server_address.clone()),
            windows_build,
        }
    }
}

/// Sends one setup step with the token, over TLS 1.3 trusting only the installer's CA.
pub async fn setup_request(
    access: &SetupAccess,
    request: SetupRequest,
    client_version: &str,
) -> Result<BridgeResponse, BridgeError> {
    if !matches!(request.method.as_str(), "GET" | "POST" | "PUT") {
        return Err(BridgeError::Invalid("method"));
    }
    if !is_setup_path(&request.path) {
        return Err(BridgeError::Invalid("path"));
    }
    let url = url::Url::parse(&format!("https://{}", access.server_address))
        .and_then(|base| base.join(&request.path))
        .map_err(|_| BridgeError::Invalid("server address"))?;
    let client = match tls::pinned_config(&access.ca_certificate_pem)
        .map_err(|e| ConnectionError::Untrusted(e.to_string()))
        .and_then(connection::client)
    {
        Ok(client) => client,
        Err(_) => return Ok(BridgeResponse::Untrusted),
    };
    let mut headers = vec![
        ("x-artepool-setup", access.token.clone()),
        ("x-artepool-client", client_version.to_string()),
        ("accept", "application/json".to_string()),
    ];
    let body = request.body.as_ref().map(|value| {
        headers.push(("content-type", "application/json".to_string()));
        serde_json::to_vec(value).expect("json")
    });
    let answer = connection::send(
        &client,
        Request {
            method: &request.method,
            url,
            headers,
            body,
        },
    )
    .await;
    Ok(match answer {
        Ok(answer) => BridgeResponse::Response {
            status: answer.status,
            content_type: answer.content_type.clone(),
            body: parse_body(&answer),
        },
        Err(ConnectionError::Unreachable(_)) => BridgeResponse::Unreachable,
        Err(ConnectionError::Untrusted(_)) => BridgeResponse::Untrusted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456";

    fn data_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("artepool-setup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("setup")).unwrap();
        std::fs::create_dir_all(dir.join("config")).unwrap();
        dir
    }

    #[test]
    fn only_setup_paths_and_well_formed_tokens() {
        assert!(is_setup_path("/api/v1/setup/status"));
        assert!(is_setup_path("/api/v1/setup/two-step/confirm"));
        for path in [
            "/api/v1/setup/",
            "/api/v1/setup/../auth/sign-in",
            "/api/v1/users",
            "/api/v1/setup/status?x=1",
            "/api/v1/setup//status",
            "/health",
        ] {
            assert!(!is_setup_path(path), "{path}");
        }
        assert!(is_setup_token(TOKEN));
        assert!(!is_setup_token(&TOKEN[1..]));
        assert!(!is_setup_token(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ012345+"
        ));
    }

    #[test]
    fn reads_the_installers_files_and_talks_to_its_own_server() {
        let dir = data_dir("read");
        std::fs::write(dir.join("setup").join("token"), format!("{TOKEN}\n")).unwrap();
        std::fs::write(
            dir.join("setup").join("ca.crt"),
            "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("config").join("server.json"),
            r#"{"version":1,"server":{"host":"0.0.0.0","port":3100},"dataDir":"C:\\ProgramData\\ARTEPOOL"}"#,
        )
        .unwrap();
        let access = SetupAccess::from_data_dir(&dir).expect("readable");
        assert_eq!(access.server_address, "127.0.0.1:3100");
        assert_eq!(
            SetupAccess::info(Some(&access), Some(19045)),
            SetupInfo {
                available: true,
                server_address: Some("127.0.0.1:3100".into()),
                windows_build: Some(19045),
            }
        );
        // The token never shows in logs.
        assert!(!format!("{access:?}").contains(TOKEN));

        // The token gone (setup completed): no wizard.
        std::fs::remove_file(dir.join("setup").join("token")).unwrap();
        assert!(SetupAccess::from_data_dir(&dir).is_none());
        assert_eq!(
            SetupAccess::info(None, None),
            SetupInfo {
                available: false,
                server_address: None,
                windows_build: None,
            }
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_malformed_token_or_missing_certificate_means_no_wizard() {
        let dir = data_dir("bad");
        std::fs::write(dir.join("setup").join("token"), "short").unwrap();
        std::fs::write(
            dir.join("config").join("server.json"),
            r#"{"server":{"port":3100}}"#,
        )
        .unwrap();
        assert!(SetupAccess::from_data_dir(&dir).is_none());
        std::fs::write(dir.join("setup").join("token"), TOKEN).unwrap();
        assert!(SetupAccess::from_data_dir(&dir).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
