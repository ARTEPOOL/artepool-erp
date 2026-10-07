//! Enrollment protocol v1 (decision 0024), the PC side. The same rules as
//! `packages/shared/src/contracts/enrollment.ts`, checked against `db/test-vectors/enrollment.json`.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::{digest, hmac, rand::SecureRandom};

pub const PROTOCOL: &str = "artepool-enroll-v1";

/// Argon2id settings for the code key; part of the protocol, both sides must match.
pub const ARGON2_MEMORY_KIB: u32 = 65_536;
pub const ARGON2_TIME: u32 = 3;
pub const ARGON2_PARALLELISM: u32 = 1;

const ARABIC_INDIC: [char; 10] = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
const EXTENDED_ARABIC_INDIC: [char; 10] = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/// What a person typed → the code as generated: capitals, ASCII digits, no spaces or dashes.
pub fn normalize_code(input: &str) -> String {
    input
        .chars()
        .map(|c| {
            ARABIC_INDIC
                .iter()
                .chain(EXTENDED_ARABIC_INDIC.iter())
                .position(|d| *d == c)
                .map(|i| char::from(b'0' + (i % 10) as u8))
                .unwrap_or(c)
        })
        .filter(|c| !c.is_whitespace() && !matches!(c, '-' | '_' | '.'))
        .flat_map(char::to_uppercase)
        .collect()
}

/// codeKey = Argon2id(normalized code, salt), 32 bytes.
pub fn derive_code_key(code: &str, salt: &[u8]) -> Result<[u8; 32], argon2::Error> {
    let params = Params::new(ARGON2_MEMORY_KIB, ARGON2_TIME, ARGON2_PARALLELISM, Some(32))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon.hash_password_into(normalize_code(code).as_bytes(), salt, &mut key)?;
    Ok(key)
}

/// HMAC-SHA256 of a protocol message, base64url without padding.
pub fn proof(code_key: &[u8], message: &str) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, code_key);
    URL_SAFE_NO_PAD.encode(hmac::sign(&key, message.as_bytes()).as_ref())
}

/// Constant-time comparison of two proofs.
pub fn proofs_equal(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Lower-case hex SHA-256 of the CA certificate as sent (PEM text, UTF-8).
pub fn ca_fingerprint(ca_certificate_pem: &str) -> String {
    digest::digest(&digest::SHA256, ca_certificate_pem.as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn transcript(client_nonce: &str, server_nonce: &str, ca_sha256_hex: &str) -> String {
    format!("{PROTOCOL}\n{client_nonce}\n{server_nonce}\n{ca_sha256_hex}")
}

pub fn server_proof_message(transcript: &str) -> String {
    format!("server\n{transcript}")
}

/// What the PC claims about itself, covered by its proof.
pub struct DeviceClaim<'a> {
    pub device_code: &'a str,
    pub device_name: &'a str,
    pub device_kind: &'a str,
    pub device_key_hash: &'a str,
}

pub fn client_proof_message(transcript: &str, device: &DeviceClaim<'_>) -> String {
    [
        "client",
        transcript,
        device.device_code,
        device.device_kind,
        device.device_name,
        device.device_key_hash,
    ]
    .join("\n")
}

/// What the server stores for a device key: its SHA-256, base64url.
pub fn key_hash(device_key: &str) -> String {
    URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, device_key.as_bytes()).as_ref())
}

/// 32 random bytes, base64url: nonces and device keys.
pub fn random32() -> String {
    let mut bytes = [0u8; 32];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .expect("the operating system's random number generator failed");
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_codes_the_way_people_type_them() {
        assert_eq!(normalize_code(" k7q-4mx 92p "), "K7Q4MX92P");
        assert_eq!(normalize_code("٢٣٤-ABC-۵۶۷"), "234ABC567");
        assert_eq!(normalize_code("a.b_c"), "ABC");
    }

    #[test]
    fn hashes_the_device_key_like_the_server() {
        assert_eq!(
            key_hash("abc"),
            "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"
        );
    }

    #[test]
    fn compares_proofs_in_constant_time() {
        assert!(proofs_equal("abc", "abc"));
        assert!(!proofs_equal("abc", "abd"));
        assert!(!proofs_equal("abc", "abcd"));
    }

    #[test]
    fn makes_fresh_random_values() {
        let (a, b) = (random32(), random32());
        assert_eq!(a.len(), 43);
        assert_ne!(a, b);
    }
}
