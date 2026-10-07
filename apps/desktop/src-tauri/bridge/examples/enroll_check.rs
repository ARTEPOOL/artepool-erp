//! Cross-check against the real API server: enroll with a one-time code, then ask the server
//! who this PC is, using only the Rust bridge (the same code as the Windows app).
//!
//!   cargo run --example enroll_check -- https://localhost:3100 K7Q-4MX-92P
//!
//! Exits with code 0 only if every step works. The enrollment is kept in memory only.

use artepool_bridge::store::MemoryStore;
use artepool_bridge::{Bridge, BridgeRequest, BridgeResponse, EnrollInput};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(server), Some(code)) = (args.next(), args.next()) else {
        eprintln!("usage: enroll_check <server address> <enrollment code> [device code]");
        std::process::exit(2);
    };
    let device_code = args.next().unwrap_or_else(|| "RUST-CHECK".into());
    let bridge = Bridge::new(
        MemoryStore::default(),
        env!("CARGO_PKG_VERSION"),
        "rust-check",
    );
    let outcome = bridge
        .enroll(EnrollInput {
            server_address: server,
            code,
            device_code: device_code.clone(),
            device_name: "Rust bridge check".into(),
            device_kind: "office".into(),
        })
        .await
        .expect("valid enrollment details");
    if !outcome.ok {
        eprintln!("enrollment failed: {:?}", outcome.reason);
        std::process::exit(1);
    }
    let me = bridge
        .request(BridgeRequest {
            method: "GET".into(),
            path: "/api/v1/devices/me".into(),
            body: None,
            token: None,
            idempotency_key: None,
            background: None,
        })
        .await
        .expect("valid request");
    match me {
        BridgeResponse::Response {
            status: 200, body, ..
        } if body["device"]["code"] == device_code.as_str() => {
            println!("ok: enrolled as {device_code} and recognised by the server");
        }
        other => {
            eprintln!("unexpected answer: {other:?}");
            std::process::exit(1);
        }
    }
}
