//! The PC side of enrollment agrees byte for byte with the shared vectors
//! (`db/test-vectors/enrollment.json`), like the server and the development bridge.

use artepool_bridge::enroll;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    device_code: String,
    device_name: String,
    device_kind: String,
    device_key_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    code_key_hex: String,
    ca_sha256_hex: String,
    transcript: String,
    server_proof: String,
    client_proof: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    code: String,
    key_salt_b64: String,
    client_nonce: String,
    server_nonce: String,
    ca_certificate_pem: String,
    device: Device,
    expected: Expected,
}

#[derive(Deserialize)]
struct File {
    protocol: String,
    vectors: Vec<Vector>,
}

#[test]
fn matches_the_shared_test_vectors() {
    let text = include_str!("../../../../../db/test-vectors/enrollment.json");
    let file: File = serde_json::from_str(text).unwrap();
    assert_eq!(file.protocol, enroll::PROTOCOL);
    assert!(!file.vectors.is_empty());
    for v in file.vectors {
        let salt = URL_SAFE_NO_PAD.decode(&v.key_salt_b64).unwrap();
        let key = enroll::derive_code_key(&v.code, &salt).unwrap();
        let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, v.expected.code_key_hex, "code key for {}", v.code);
        assert_eq!(
            enroll::ca_fingerprint(&v.ca_certificate_pem),
            v.expected.ca_sha256_hex
        );
        let transcript =
            enroll::transcript(&v.client_nonce, &v.server_nonce, &v.expected.ca_sha256_hex);
        assert_eq!(transcript, v.expected.transcript);
        assert_eq!(
            enroll::proof(&key, &enroll::server_proof_message(&transcript)),
            v.expected.server_proof
        );
        let claim = enroll::DeviceClaim {
            device_code: &v.device.device_code,
            device_name: &v.device.device_name,
            device_kind: &v.device.device_kind,
            device_key_hash: &v.device.device_key_hash,
        };
        assert_eq!(
            enroll::proof(&key, &enroll::client_proof_message(&transcript, &claim)),
            v.expected.client_proof
        );
    }
}
