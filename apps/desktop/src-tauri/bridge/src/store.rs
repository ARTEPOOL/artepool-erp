//! Where the PC keeps its enrollment: the server address, the pinned ARTÉPOOL CA and the device
//! key. On Windows it is one entry in Windows Credential Manager (decision 0024), protected by
//! the Windows account; it never reaches the screens.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub code: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDevice {
    pub version: u8,
    pub server_url: String,
    pub ca_certificate_pem: String,
    pub device_key: String,
    /// A new key sent for renewal but not yet confirmed (tried if the answer was lost).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_key: Option<String>,
    pub key_expires_at: String,
    pub device: DeviceInfo,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("the secure store could not be used: {0}")]
    Unavailable(String),
    #[error("the stored enrollment is damaged: {0}")]
    Damaged(String),
}

pub trait SecretStore: Send + Sync {
    fn load(&self) -> Result<Option<StoredDevice>, StoreError>;
    fn save(&self, device: &StoredDevice) -> Result<(), StoreError>;
}

fn decode(bytes: &[u8]) -> Result<StoredDevice, StoreError> {
    let device: StoredDevice =
        serde_json::from_slice(bytes).map_err(|e| StoreError::Damaged(e.to_string()))?;
    if device.version != 1 {
        return Err(StoreError::Damaged(format!(
            "unknown version {}",
            device.version
        )));
    }
    Ok(device)
}

fn encode(device: &StoredDevice) -> Vec<u8> {
    serde_json::to_vec(device).expect("a stored device always serializes")
}

/// For tests.
#[derive(Default)]
pub struct MemoryStore(Mutex<Option<StoredDevice>>);

impl MemoryStore {
    pub fn with(device: StoredDevice) -> Self {
        Self(Mutex::new(Some(device)))
    }
}

impl SecretStore for MemoryStore {
    fn load(&self) -> Result<Option<StoredDevice>, StoreError> {
        Ok(self.0.lock().expect("store lock").clone())
    }
    fn save(&self, device: &StoredDevice) -> Result<(), StoreError> {
        *self.0.lock().expect("store lock") = Some(device.clone());
        Ok(())
    }
}

/// Windows Credential Manager: one generic credential, readable by this Windows account only.
#[cfg(windows)]
pub struct CredentialStore {
    entry: keyring::Entry,
}

#[cfg(windows)]
impl CredentialStore {
    /// Credential Manager keeps at most 2,560 bytes per credential.
    const MAX_BYTES: usize = 2_560;

    pub fn new(service: &str, account: &str) -> Result<Self, StoreError> {
        keyring::Entry::new(service, account)
            .map(|entry| Self { entry })
            .map_err(|e| StoreError::Unavailable(e.to_string()))
    }
}

#[cfg(windows)]
impl SecretStore for CredentialStore {
    fn load(&self) -> Result<Option<StoredDevice>, StoreError> {
        match self.entry.get_secret() {
            Ok(bytes) => decode(&bytes).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(StoreError::Unavailable(e.to_string())),
        }
    }
    fn save(&self, device: &StoredDevice) -> Result<(), StoreError> {
        let bytes = encode(device);
        if bytes.len() > Self::MAX_BYTES {
            return Err(StoreError::Unavailable(format!(
                "the enrollment needs {} bytes; Credential Manager allows {}",
                bytes.len(),
                Self::MAX_BYTES
            )));
        }
        self.entry
            .set_secret(&bytes)
            .map_err(|e| StoreError::Unavailable(e.to_string()))
    }
}

/// Development builds on other systems: a file readable by its owner only.
#[cfg(not(windows))]
pub struct FileStore(std::path::PathBuf);

#[cfg(not(windows))]
impl FileStore {
    pub fn new(path: std::path::PathBuf) -> Self {
        Self(path)
    }
}

#[cfg(not(windows))]
impl SecretStore for FileStore {
    fn load(&self) -> Result<Option<StoredDevice>, StoreError> {
        match std::fs::read(&self.0) {
            Ok(bytes) => decode(&bytes).map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(StoreError::Unavailable(e.to_string())),
        }
    }
    fn save(&self, device: &StoredDevice) -> Result<(), StoreError> {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let unavailable = |e: std::io::Error| StoreError::Unavailable(e.to_string());
        if let Some(dir) = self.0.parent() {
            std::fs::create_dir_all(dir).map_err(unavailable)?;
        }
        let temporary = self.0.with_extension("tmp");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(unavailable)?;
        file.write_all(&encode(device)).map_err(unavailable)?;
        file.sync_all().map_err(unavailable)?;
        std::fs::rename(&temporary, &self.0).map_err(unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn sample() -> StoredDevice {
        StoredDevice {
            version: 1,
            server_url: "https://artepool-server:3100".into(),
            ca_certificate_pem: "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n"
                .into(),
            device_key: "k".repeat(43),
            pending_key: None,
            key_expires_at: "2027-10-07T00:00:00.000Z".into(),
            device: DeviceInfo {
                id: "7".into(),
                code: "COUNTER-01".into(),
                name: "Counter".into(),
                kind: "pos".into(),
            },
        }
    }

    #[test]
    fn uses_the_same_format_as_the_development_bridge() {
        let text = String::from_utf8(encode(&sample())).unwrap();
        assert!(text.contains("\"serverUrl\":\"https://artepool-server:3100\""));
        assert!(text.contains("\"caCertificatePem\""));
        assert!(!text.contains("pendingKey"));
        assert_eq!(decode(text.as_bytes()).unwrap(), sample());
        assert!(decode(b"{\"version\":2}").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn keeps_the_enrollment_in_windows_credential_manager() {
        let service = format!("ARTEPOOL ERP test {}", std::process::id());
        let store = CredentialStore::new(&service, "device").unwrap();
        assert_eq!(store.load().unwrap(), None);
        store.save(&sample()).unwrap();
        assert_eq!(store.load().unwrap(), Some(sample()));
        // Test clean-up only; the app itself never removes the enrollment.
        keyring::Entry::new(&service, "device")
            .unwrap()
            .delete_credential()
            .unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn the_development_file_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("artepool-store-{}", std::process::id()));
        let store = FileStore::new(dir.join("device.json"));
        assert_eq!(store.load().unwrap(), None);
        store.save(&sample()).unwrap();
        assert_eq!(store.load().unwrap(), Some(sample()));
        let mode = std::fs::metadata(dir.join("device.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
