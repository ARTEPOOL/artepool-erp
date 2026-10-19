//! The PC's secure side of ARTÉPOOL ERP (architecture §6, decision 0024).
//!
//! The screens never see the device key and never open a connection. They ask this bridge to
//! enroll the PC or to send an API request; it adds the device key and the app version, connects
//! with TLS 1.3 trusting only the pinned ARTÉPOOL CA, and hands back the answer. The same
//! contract as `packages/shared/src/contracts/bridge.ts`; the development bridge
//! (`tools/dev-bridge`) behaves the same way.

pub mod connection;
pub mod enroll;
pub mod loopback;
pub mod rules;
pub mod store;
pub mod tls;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use connection::{Answer, ConnectionError, Request};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use store::{DeviceInfo, SecretStore, StoreError, StoredDevice};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// Renew the device key this long before it expires (the server accepts it from then).
const RENEW_BEFORE: time::Duration = time::Duration::days(30);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDeviceInfo {
    pub code: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDevice {
    pub enrolled: bool,
    pub server_url: Option<String>,
    pub device: Option<LocalDeviceInfo>,
    pub suggested_code: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnrollInput {
    pub server_address: String,
    pub code: String,
    pub device_code: String,
    pub device_name: String,
    pub device_kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnrollOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<DeviceInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

impl EnrollOutcome {
    fn failed(reason: &'static str) -> Self {
        Self {
            ok: false,
            server_url: None,
            device: None,
            reason: Some(reason),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub background: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BridgeResponse {
    #[serde(rename_all = "camelCase")]
    Response {
        status: u16,
        content_type: String,
        body: Value,
    },
    Unreachable,
    Untrusted,
    NotEnrolled,
}

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("refused: {0}")]
    Invalid(&'static str),
    #[error(transparent)]
    Store(#[from] StoreError),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloAnswer {
    ca_certificate_pem: String,
    server_nonce: String,
    key_salt: String,
    server_proof: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteAnswer {
    device: DeviceInfo,
    key_expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenewAnswer {
    renewed: bool,
    key_expires_at: String,
}

fn parse_body(answer: &Answer) -> Value {
    if answer.content_type.contains("application/json")
        && let Ok(value) = serde_json::from_slice(&answer.body)
    {
        return value;
    }
    Value::String(String::from_utf8_lossy(&answer.body).into_owned())
}

fn error_code(body: &Value) -> Option<&str> {
    body.get("error")?.get("code")?.as_str()
}

fn status_failure(answer: &Answer) -> &'static str {
    match error_code(&parse_body(answer)) {
        Some("ENROLLMENT_FAILED") => "code_rejected",
        Some("ENROLLMENT_UNAVAILABLE") => "unavailable",
        Some("DEVICE_CODE_TAKEN") => "code_taken",
        _ if answer.status >= 500 => "unavailable",
        _ => "not_genuine",
    }
}

fn failure_of(error: &ConnectionError) -> &'static str {
    match error {
        ConnectionError::Untrusted(_) => "not_genuine",
        ConnectionError::Unreachable(_) => "unreachable",
    }
}

fn due_for_renewal(key_expires_at: &str) -> bool {
    OffsetDateTime::parse(key_expires_at, &Rfc3339).map_or(true, |expires| {
        expires - OffsetDateTime::now_utc() < RENEW_BEFORE
    })
}

pub struct Bridge<S: SecretStore> {
    store: S,
    client_version: String,
    computer_name: String,
    renewing: tokio::sync::Mutex<()>,
    /// One pooled client per (server, CA), so connections are reused.
    pinned: Mutex<Option<(String, reqwest::Client)>>,
}

impl<S: SecretStore> Bridge<S> {
    pub fn new(
        store: S,
        client_version: impl Into<String>,
        computer_name: impl Into<String>,
    ) -> Self {
        Self {
            store,
            client_version: client_version.into(),
            computer_name: computer_name.into(),
            renewing: tokio::sync::Mutex::new(()),
            pinned: Mutex::new(None),
        }
    }

    pub fn local_device(&self) -> Result<LocalDevice, BridgeError> {
        let stored = self.store.load()?;
        Ok(LocalDevice {
            enrolled: stored.is_some(),
            server_url: stored.as_ref().map(|s| s.server_url.clone()),
            device: stored.map(|s| LocalDeviceInfo {
                code: s.device.code,
                name: s.device.name,
                kind: s.device.kind,
            }),
            suggested_code: rules::suggested_code(&self.computer_name),
        })
    }

    fn pinned_client(&self, stored: &StoredDevice) -> Result<reqwest::Client, ConnectionError> {
        let key = format!(
            "{}|{}",
            stored.server_url,
            enroll::ca_fingerprint(&stored.ca_certificate_pem)
        );
        let mut cache = self.pinned.lock().expect("client cache lock");
        if let Some((cached_key, client)) = cache.as_ref()
            && *cached_key == key
        {
            return Ok(client.clone());
        }
        let config = tls::pinned_config(&stored.ca_certificate_pem)
            .map_err(|e| ConnectionError::Untrusted(e.to_string()))?;
        let client = connection::client(config)?;
        *cache = Some((key, client.clone()));
        Ok(client)
    }

    /// Enrollment protocol v1: the code proves the server first, then the PC.
    pub async fn enroll(&self, input: EnrollInput) -> Result<EnrollOutcome, BridgeError> {
        let code = input.code.trim().to_string();
        let device_name = input.device_name.trim().to_string();
        if code.is_empty()
            || code.chars().count() > 32
            || device_name.is_empty()
            || device_name.chars().count() > 100
            || !rules::is_device_code(&input.device_code)
            || !matches!(input.device_kind.as_str(), "pos" | "office" | "warehouse")
        {
            return Err(BridgeError::Invalid("enrollment details"));
        }
        let Some(server_url) = rules::server_url_from(&input.server_address) else {
            return Ok(EnrollOutcome::failed("invalid_address"));
        };
        let base = url::Url::parse(&server_url).expect("server_url_from returns a valid URL");
        let host = base.host_str().unwrap_or_default().to_string();
        let headers = || {
            vec![
                ("content-type", "application/json".to_string()),
                ("x-artepool-client", self.client_version.clone()),
            ]
        };

        // 1. hello: the PC does not know the CA yet; this answer is checked by its proof.
        let client_nonce = enroll::random32();
        let (config, captured) = tls::capturing_config();
        let hello_client = match connection::client(config) {
            Ok(client) => client,
            Err(error) => return Ok(EnrollOutcome::failed(failure_of(&error))),
        };
        let hello = connection::send(
            &hello_client,
            Request {
                method: "POST",
                url: base.join("/api/v1/enroll/hello").expect("valid path"),
                headers: headers(),
                body: Some(
                    serde_json::to_vec(&serde_json::json!({ "clientNonce": client_nonce }))
                        .expect("json"),
                ),
            },
        )
        .await;
        let hello = match hello {
            Ok(answer) => answer,
            Err(error) => return Ok(EnrollOutcome::failed(failure_of(&error))),
        };
        if hello.status == 429 {
            return Ok(EnrollOutcome::failed("rate_limited"));
        }
        if hello.status != 200 {
            return Ok(EnrollOutcome::failed(status_failure(&hello)));
        }
        let Ok(hello) = serde_json::from_slice::<HelloAnswer>(&hello.body) else {
            return Ok(EnrollOutcome::failed("not_genuine"));
        };
        let Ok(salt) = URL_SAFE_NO_PAD.decode(&hello.key_salt) else {
            return Ok(EnrollOutcome::failed("not_genuine"));
        };

        // 2. Only someone who knows the code can make this proof: the genuine server.
        let typed = code.clone();
        let code_key =
            match tokio::task::spawn_blocking(move || enroll::derive_code_key(&typed, &salt)).await
            {
                Ok(Ok(key)) => key,
                _ => return Ok(EnrollOutcome::failed("not_genuine")),
            };
        let transcript = enroll::transcript(
            &client_nonce,
            &hello.server_nonce,
            &enroll::ca_fingerprint(&hello.ca_certificate_pem),
        );
        let expected = enroll::proof(&code_key, &enroll::server_proof_message(&transcript));
        if !enroll::proofs_equal(&expected, &hello.server_proof) {
            return Ok(EnrollOutcome::failed("not_genuine"));
        }
        // …and the hello came from a server that CA vouches for, under this name.
        let presented = captured.lock().expect("capture lock").clone();
        if !presented.is_some_and(|cert| tls::issued_for(&cert, &hello.ca_certificate_pem, &host)) {
            return Ok(EnrollOutcome::failed("not_genuine"));
        }

        // 3. complete, over TLS that trusts only that CA. The PC makes its own key.
        let device_key = enroll::random32();
        let device_key_hash = enroll::key_hash(&device_key);
        let claim = enroll::DeviceClaim {
            device_code: &input.device_code,
            device_name: &device_name,
            device_kind: &input.device_kind,
            device_key_hash: &device_key_hash,
        };
        let client_proof = enroll::proof(
            &code_key,
            &enroll::client_proof_message(&transcript, &claim),
        );
        let pinned = match tls::pinned_config(&hello.ca_certificate_pem)
            .map_err(|e| ConnectionError::Untrusted(e.to_string()))
            .and_then(connection::client)
        {
            Ok(client) => client,
            Err(error) => return Ok(EnrollOutcome::failed(failure_of(&error))),
        };
        let body = serde_json::json!({
            "clientNonce": client_nonce,
            "serverNonce": hello.server_nonce,
            "deviceCode": input.device_code,
            "deviceName": device_name,
            "deviceKind": input.device_kind,
            "deviceKeyHash": device_key_hash,
            "clientProof": client_proof,
        });
        let complete = connection::send(
            &pinned,
            Request {
                method: "POST",
                url: base.join("/api/v1/enroll/complete").expect("valid path"),
                headers: headers(),
                body: Some(serde_json::to_vec(&body).expect("json")),
            },
        )
        .await;
        let complete = match complete {
            Ok(answer) => answer,
            Err(error) => return Ok(EnrollOutcome::failed(failure_of(&error))),
        };
        if complete.status == 429 {
            return Ok(EnrollOutcome::failed("rate_limited"));
        }
        if complete.status != 201 {
            return Ok(EnrollOutcome::failed(status_failure(&complete)));
        }
        let Ok(done) = serde_json::from_slice::<CompleteAnswer>(&complete.body) else {
            return Ok(EnrollOutcome::failed("unavailable"));
        };
        self.store.save(&StoredDevice {
            version: 1,
            server_url: server_url.clone(),
            ca_certificate_pem: hello.ca_certificate_pem,
            device_key,
            pending_key: None,
            key_expires_at: done.key_expires_at,
            device: done.device.clone(),
        })?;
        *self.pinned.lock().expect("client cache lock") = None;
        Ok(EnrollOutcome {
            ok: true,
            server_url: Some(server_url),
            device: Some(done.device),
            reason: None,
        })
    }

    /// One API request with this PC's key; renews the key first when it is due.
    pub async fn request(&self, request: BridgeRequest) -> Result<BridgeResponse, BridgeError> {
        if !matches!(request.method.as_str(), "GET" | "POST" | "PATCH" | "PUT") {
            return Err(BridgeError::Invalid("method"));
        }
        if !rules::is_allowed_path(&request.path) {
            return Err(BridgeError::Invalid("path"));
        }
        if request
            .token
            .as_deref()
            .is_some_and(|t| !rules::is_token(t))
        {
            return Err(BridgeError::Invalid("token"));
        }
        if request
            .idempotency_key
            .as_deref()
            .is_some_and(|k| !rules::is_uuid(k))
        {
            return Err(BridgeError::Invalid("idempotency key"));
        }
        let Some(mut stored) = self.store.load()? else {
            return Ok(BridgeResponse::NotEnrolled);
        };
        if due_for_renewal(&stored.key_expires_at) {
            let _guard = self.renewing.lock().await;
            if let Some(current) = self.store.load()? {
                if due_for_renewal(&current.key_expires_at) {
                    self.renew(&current).await?;
                }
                stored = self.store.load()?.unwrap_or(current);
            }
        }
        let first = self.send_with(&stored, &stored.device_key, &request).await;
        let answer = match (&first, &stored.pending_key) {
            (
                Ok(BridgeResponse::Response {
                    status: 401, body, ..
                }),
                Some(pending),
            ) if error_code(body) == Some("DEVICE_NOT_ENROLLED") => {
                // A renewal whose answer was lost: the server may already expect the new key.
                let retry = self.send_with(&stored, pending, &request).await;
                match &retry {
                    Ok(BridgeResponse::Response { status, body, .. })
                        if !(*status == 401 && error_code(body) == Some("DEVICE_NOT_ENROLLED")) =>
                    {
                        self.store.save(&StoredDevice {
                            device_key: pending.clone(),
                            pending_key: None,
                            ..stored.clone()
                        })?;
                        retry
                    }
                    _ => first,
                }
            }
            _ => first,
        };
        Ok(answer.unwrap_or_else(|error| match error {
            ConnectionError::Unreachable(_) => BridgeResponse::Unreachable,
            ConnectionError::Untrusted(_) => BridgeResponse::Untrusted,
        }))
    }

    async fn send_with(
        &self,
        stored: &StoredDevice,
        device_key: &str,
        request: &BridgeRequest,
    ) -> Result<BridgeResponse, ConnectionError> {
        let client = self.pinned_client(stored)?;
        let base = url::Url::parse(&stored.server_url)
            .map_err(|e| ConnectionError::Unreachable(e.to_string()))?;
        let url = base
            .join(&request.path)
            .map_err(|e| ConnectionError::Unreachable(e.to_string()))?;
        let mut headers = vec![
            ("x-artepool-device", device_key.to_string()),
            ("x-artepool-client", self.client_version.clone()),
            ("accept", "application/json, text/csv".to_string()),
        ];
        if let Some(token) = &request.token {
            headers.push(("authorization", format!("Bearer {token}")));
        }
        if let Some(key) = &request.idempotency_key {
            headers.push(("idempotency-key", key.clone()));
        }
        if request.background == Some(true) {
            headers.push(("x-artepool-background", "1".to_string()));
        }
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
        .await?;
        Ok(BridgeResponse::Response {
            status: answer.status,
            content_type: answer.content_type.clone(),
            body: parse_body(&answer),
        })
    }

    /// Key renewal: the new key is saved as pending before the server ever sees it.
    async fn renew(&self, stored: &StoredDevice) -> Result<(), BridgeError> {
        let new_key = stored.pending_key.clone().unwrap_or_else(enroll::random32);
        let with_pending = StoredDevice {
            pending_key: Some(new_key.clone()),
            ..stored.clone()
        };
        self.store.save(&with_pending)?;
        let request = BridgeRequest {
            method: "POST".into(),
            path: "/api/v1/devices/me/renew-key".into(),
            body: Some(serde_json::json!({ "newKeyHash": enroll::key_hash(&new_key) })),
            token: None,
            idempotency_key: None,
            background: None,
        };
        // Not reachable now: the next request tries again; the pending key is kept.
        if let Ok(BridgeResponse::Response {
            status: 200, body, ..
        }) = self.send_with(stored, &stored.device_key, &request).await
            && let Ok(result) = serde_json::from_value::<RenewAnswer>(body)
        {
            self.store.save(&StoredDevice {
                device_key: if result.renewed {
                    new_key
                } else {
                    stored.device_key.clone()
                },
                pending_key: None,
                key_expires_at: result.key_expires_at,
                ..with_pending
            })?;
        }
        Ok(())
    }
}
