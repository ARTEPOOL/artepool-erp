//! The whole PC side against a small stand-in server that plays the real server's part of
//! enrollment protocol v1: enroll with the one-time code, requests with the device key, trusting
//! only the pinned CA afterwards, and key renewal (also when its answer is lost).

mod support;

use artepool_bridge::store::{MemoryStore, SecretStore, StoredDevice};
use artepool_bridge::{Bridge, BridgeError, BridgeRequest, BridgeResponse, EnrollInput, enroll};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use support::{Ca, HttpRequest, HttpResponse, Server, serve};

const CODE: &str = "K7Q-4MX-92P";

#[derive(Default)]
struct State {
    ca_pem: String,
    client_nonce: String,
    server_nonce: String,
    salt: Vec<u8>,
    key_hash: Option<String>,
    key_expires_at: String,
    /// Renewal: accept the new key but answer 503, as if the answer were lost.
    lose_renewal_answer: bool,
    seen: Vec<HttpRequest>,
}

fn error(status: u16, code: &str) -> HttpResponse {
    HttpResponse {
        status,
        body: json!({ "error": { "code": code, "details": {} } }),
    }
}

fn device() -> Value {
    json!({ "id": "7", "code": "COUNTER-01", "name": "Showroom counter", "kind": "pos" })
}

/// The server's side of the protocol (the real one is apps/server/src/modules/devices).
fn handle(state: &Mutex<State>, request: &HttpRequest) -> HttpResponse {
    let mut s = state.lock().unwrap();
    s.seen.push(request.clone());
    let body = request.json();
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/api/v1/enroll/hello") => {
            s.client_nonce = body["clientNonce"].as_str().unwrap_or_default().to_string();
            s.server_nonce = enroll::random32();
            s.salt = vec![7u8; 16];
            let key = enroll::derive_code_key(CODE, &s.salt).unwrap();
            let transcript = enroll::transcript(
                &s.client_nonce,
                &s.server_nonce,
                &enroll::ca_fingerprint(&s.ca_pem),
            );
            HttpResponse {
                status: 200,
                body: json!({
                    "protocol": enroll::PROTOCOL,
                    "caCertificatePem": s.ca_pem,
                    "serverNonce": s.server_nonce,
                    "keySalt": URL_SAFE_NO_PAD.encode(&s.salt),
                    "serverProof": enroll::proof(&key, &enroll::server_proof_message(&transcript)),
                }),
            }
        }
        ("POST", "/api/v1/enroll/complete") => {
            let key = enroll::derive_code_key(CODE, &s.salt).unwrap();
            let transcript = enroll::transcript(
                &s.client_nonce,
                &s.server_nonce,
                &enroll::ca_fingerprint(&s.ca_pem),
            );
            let claim = enroll::DeviceClaim {
                device_code: body["deviceCode"].as_str().unwrap_or_default(),
                device_name: body["deviceName"].as_str().unwrap_or_default(),
                device_kind: body["deviceKind"].as_str().unwrap_or_default(),
                device_key_hash: body["deviceKeyHash"].as_str().unwrap_or_default(),
            };
            let expected = enroll::proof(&key, &enroll::client_proof_message(&transcript, &claim));
            if body["clientProof"].as_str() != Some(expected.as_str()) {
                return error(401, "ENROLLMENT_FAILED");
            }
            s.key_hash = Some(claim.device_key_hash.to_string());
            HttpResponse {
                status: 201,
                body: json!({ "device": device(), "keyExpiresAt": s.key_expires_at }),
            }
        }
        (method, path) => {
            let presented = request
                .headers
                .get("x-artepool-device")
                .map(|k| enroll::key_hash(k));
            if presented.is_none() || presented != s.key_hash {
                return error(401, "DEVICE_NOT_ENROLLED");
            }
            match (method, path) {
                ("POST", "/api/v1/devices/me/renew-key") => {
                    s.key_hash = body["newKeyHash"].as_str().map(str::to_string);
                    s.key_expires_at = "2030-01-01T00:00:00.000Z".into();
                    if s.lose_renewal_answer {
                        return error(503, "INTERNAL");
                    }
                    HttpResponse {
                        status: 200,
                        body: json!({ "renewed": true, "keyExpiresAt": s.key_expires_at }),
                    }
                }
                ("GET", "/api/v1/devices/me") => HttpResponse {
                    status: 200,
                    body: json!({ "device": device(), "keyExpiresAt": s.key_expires_at }),
                },
                _ => error(404, "NOT_FOUND"),
            }
        }
    }
}

async fn stand_in_server() -> (Server, Arc<Mutex<State>>) {
    let ca = Ca::new(&["localhost", "127.0.0.1"]);
    let (chain, key) = ca.issue(&["localhost"]);
    let state = Arc::new(Mutex::new(State {
        ca_pem: ca.pem.clone(),
        key_expires_at: "2030-01-01T00:00:00.000Z".into(),
        ..State::default()
    }));
    let handler_state = Arc::clone(&state);
    let server = serve(
        chain,
        key,
        false,
        Arc::new(move |r| handle(&handler_state, r)),
    )
    .await;
    (server, state)
}

fn input(server: &Server, code: &str) -> EnrollInput {
    EnrollInput {
        server_address: server.url(),
        code: code.into(),
        device_code: "COUNTER-01".into(),
        device_name: "Showroom counter".into(),
        device_kind: "pos".into(),
    }
}

fn get(path: &str) -> BridgeRequest {
    BridgeRequest {
        method: "GET".into(),
        path: path.into(),
        body: None,
        token: None,
        idempotency_key: None,
        background: None,
    }
}

fn status(response: &BridgeResponse) -> u16 {
    match response {
        BridgeResponse::Response { status, .. } => *status,
        other => panic!("no answer: {other:?}"),
    }
}

#[tokio::test]
async fn enrolls_with_the_code_then_sends_requests_with_its_own_key() {
    let (server, state) = stand_in_server().await;
    let bridge = Bridge::new(MemoryStore::default(), "0.1.0", "counter-01");
    let before = bridge.local_device().unwrap();
    assert!(!before.enrolled);
    assert_eq!(before.suggested_code, "COUNTER-01");
    assert_eq!(
        bridge.request(get("/api/v1/devices/me")).await.unwrap(),
        BridgeResponse::NotEnrolled
    );

    let outcome = bridge.enroll(input(&server, "k7q 4mx 92p")).await.unwrap();
    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(outcome.device.unwrap().code, "COUNTER-01");
    let local = bridge.local_device().unwrap();
    assert!(local.enrolled);
    assert_eq!(local.device.unwrap().name, "Showroom counter");

    let mut request = get("/api/v1/devices/me");
    request.token = Some("session_token-1".into());
    request.idempotency_key = Some("0f8fad5b-d9cb-469f-a165-70867728950e".into());
    request.background = Some(true);
    let answer = bridge.request(request).await.unwrap();
    assert_eq!(status(&answer), 200);
    let s = state.lock().unwrap();
    let last = s.seen.last().unwrap();
    assert_eq!(
        last.headers.get("x-artepool-client").map(String::as_str),
        Some("0.1.0")
    );
    assert_eq!(
        last.headers.get("authorization").map(String::as_str),
        Some("Bearer session_token-1")
    );
    assert_eq!(
        last.headers.get("idempotency-key").map(String::as_str),
        Some("0f8fad5b-d9cb-469f-a165-70867728950e")
    );
    assert_eq!(
        last.headers
            .get("x-artepool-background")
            .map(String::as_str),
        Some("1")
    );
    // The server only ever saw the key's hash during enrollment.
    let complete = s
        .seen
        .iter()
        .find(|r| r.path == "/api/v1/enroll/complete")
        .unwrap();
    assert!(!String::from_utf8_lossy(&complete.body).contains(CODE));
}

#[tokio::test]
async fn refuses_to_trust_the_server_when_the_code_is_wrong() {
    let (server, _) = stand_in_server().await;
    let store = MemoryStore::default();
    let bridge = Bridge::new(store, "0.1.0", "pc");
    let outcome = bridge.enroll(input(&server, "ZZZ-ZZZ-ZZZ")).await.unwrap();
    assert_eq!(outcome.reason, Some("not_genuine"));
    assert!(!bridge.local_device().unwrap().enrolled);
}

#[tokio::test]
async fn explains_addresses_it_cannot_use_or_reach() {
    let bridge = Bridge::new(MemoryStore::default(), "0.1.0", "pc");
    let mut bad = EnrollInput {
        server_address: "http://plain".into(),
        code: CODE.into(),
        device_code: "PC-01".into(),
        device_name: "Office".into(),
        device_kind: "office".into(),
    };
    assert_eq!(
        bridge.enroll(bad.clone()).await.unwrap().reason,
        Some("invalid_address")
    );
    bad.server_address = "https://127.0.0.1:1".into();
    assert_eq!(
        bridge.enroll(bad).await.unwrap().reason,
        Some("unreachable")
    );
}

struct SharedStore(Arc<MemoryStore>);

impl SecretStore for SharedStore {
    fn load(&self) -> Result<Option<StoredDevice>, artepool_bridge::store::StoreError> {
        self.0.load()
    }
    fn save(&self, device: &StoredDevice) -> Result<(), artepool_bridge::store::StoreError> {
        self.0.save(device)
    }
}

async fn enrolled(server: &Server) -> (Bridge<SharedStore>, Arc<MemoryStore>) {
    let store = Arc::new(MemoryStore::default());
    let bridge = Bridge::new(SharedStore(Arc::clone(&store)), "0.1.0", "pc");
    assert!(bridge.enroll(input(server, CODE)).await.unwrap().ok);
    (bridge, store)
}

#[tokio::test]
async fn after_enrollment_another_server_at_that_address_is_not_trusted() {
    let (server, _) = stand_in_server().await;
    let (bridge, store) = enrolled(&server).await;
    let stored = store.load().unwrap().unwrap();
    let (impostor, _) = stand_in_server().await; // its own CA, same name
    store
        .save(&StoredDevice {
            server_url: impostor.url(),
            ..stored.clone()
        })
        .unwrap();
    assert_eq!(
        bridge.request(get("/api/v1/devices/me")).await.unwrap(),
        BridgeResponse::Untrusted
    );

    store.save(&stored).unwrap();
    assert_eq!(
        status(&bridge.request(get("/api/v1/devices/me")).await.unwrap()),
        200
    );
    drop(server);
    assert_eq!(
        bridge.request(get("/api/v1/devices/me")).await.unwrap(),
        BridgeResponse::Unreachable
    );
}

#[tokio::test]
async fn renews_its_key_30_days_before_it_expires() {
    let (server, state) = stand_in_server().await;
    let (bridge, store) = enrolled(&server).await;
    let before = store.load().unwrap().unwrap();
    store
        .save(&StoredDevice {
            key_expires_at: "2000-01-01T00:00:00.000Z".into(),
            ..before.clone()
        })
        .unwrap();

    assert_eq!(
        status(&bridge.request(get("/api/v1/devices/me")).await.unwrap()),
        200
    );
    let after = store.load().unwrap().unwrap();
    assert_ne!(after.device_key, before.device_key);
    assert_eq!(after.pending_key, None);
    assert_eq!(after.key_expires_at, "2030-01-01T00:00:00.000Z");
    assert_eq!(
        state.lock().unwrap().key_hash,
        Some(enroll::key_hash(&after.device_key))
    );
}

#[tokio::test]
async fn recovers_when_the_renewal_answer_was_lost() {
    let (server, state) = stand_in_server().await;
    let (bridge, store) = enrolled(&server).await;
    let before = store.load().unwrap().unwrap();
    state.lock().unwrap().lose_renewal_answer = true;
    store
        .save(&StoredDevice {
            key_expires_at: "2000-01-01T00:00:00.000Z".into(),
            ..before.clone()
        })
        .unwrap();

    // The server switched keys but the PC never heard back: the pending key is used.
    assert_eq!(
        status(&bridge.request(get("/api/v1/devices/me")).await.unwrap()),
        200
    );
    let after = store.load().unwrap().unwrap();
    assert_ne!(after.device_key, before.device_key);
    assert_eq!(after.pending_key, None);
    assert_eq!(
        state.lock().unwrap().key_hash,
        Some(enroll::key_hash(&after.device_key))
    );
}

#[tokio::test]
async fn refuses_requests_outside_the_rules() {
    let (server, _) = stand_in_server().await;
    let (bridge, _) = enrolled(&server).await;
    assert!(matches!(
        bridge.request(get("/admin")).await,
        Err(BridgeError::Invalid(_))
    ));
    let mut bad_token = get("/api/v1/devices/me");
    bad_token.token = Some("a\r\nx-evil: 1".into());
    assert!(matches!(
        bridge.request(bad_token).await,
        Err(BridgeError::Invalid(_))
    ));
    let mut delete = get("/api/v1/devices/me");
    delete.method = "DELETE".into();
    assert!(matches!(
        bridge.request(delete).await,
        Err(BridgeError::Invalid(_))
    ));
}
