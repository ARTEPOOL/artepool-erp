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

    /// Removes this account's copy once the enrollment is kept for the whole PC (M6.4).
    pub fn forget(&self) -> Result<(), StoreError> {
        match self.entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(StoreError::Unavailable(e.to_string())),
        }
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

/// Seals the enrollment file for this PC only (DPAPI with the machine's key on Windows).
pub trait Sealer: Send + Sync {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String>;
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String>;
}

/// The server PC's enrollment for the whole PC (M6.4): one file in
/// `C:\ProgramData\ARTEPOOL\device`, sealed with the PC's own key, so the owner's and the cashier's
/// Windows accounts use the same enrolled PC (same device, same drawer). The folder's access rules
/// (set by the launcher) let the PC's accounts read and renew it; the seal opens on this PC only.
pub struct MachineStore<K: Sealer> {
    file: std::path::PathBuf,
    sealer: K,
}

impl<K: Sealer> MachineStore<K> {
    pub fn new(file: std::path::PathBuf, sealer: K) -> Self {
        Self { file, sealer }
    }
}

impl<K: Sealer> SecretStore for MachineStore<K> {
    fn load(&self) -> Result<Option<StoredDevice>, StoreError> {
        match std::fs::read(&self.file) {
            Ok(sealed) => {
                let plain = self.sealer.open(&sealed).map_err(StoreError::Damaged)?;
                decode(&plain).map(Some)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(StoreError::Unavailable(e.to_string())),
        }
    }
    fn save(&self, device: &StoredDevice) -> Result<(), StoreError> {
        use std::io::Write as _;
        let unavailable = |e: std::io::Error| StoreError::Unavailable(e.to_string());
        let sealed = self
            .sealer
            .seal(&encode(device))
            .map_err(StoreError::Unavailable)?;
        // Through a temporary file and a rename: a power cut never leaves half an enrollment.
        let temporary = self.file.with_extension("tmp");
        let mut file = std::fs::File::create(&temporary).map_err(unavailable)?;
        file.write_all(&sealed).map_err(unavailable)?;
        file.sync_all().map_err(unavailable)?;
        drop(file);
        std::fs::rename(&temporary, &self.file).map_err(unavailable)
    }
}

/// Moves an enrollment kept in a Windows account to the whole-PC file, once: only when the file
/// has none and the account has one. The account's copy is removed only after the file is
/// written and reads back the same. Returns whether it moved.
pub fn move_to_machine(
    machine: &dyn SecretStore,
    account: &dyn SecretStore,
    forget_account: impl FnOnce() -> Result<(), StoreError>,
) -> Result<bool, StoreError> {
    if machine.load()?.is_some() {
        return Ok(false);
    }
    let Some(device) = account.load()? else {
        return Ok(false);
    };
    machine.save(&device)?;
    if machine.load()?.as_ref() != Some(&device) {
        return Err(StoreError::Damaged(
            "the enrollment did not read back the same".into(),
        ));
    }
    forget_account()?;
    Ok(true)
}

/// DPAPI with the machine's key, bound to the enrollment by its own entropy.
#[cfg(windows)]
pub struct MachineDpapi;

#[cfg(windows)]
mod dpapi {
    use std::ffi::c_void;

    #[repr(C)]
    pub struct DataBlob {
        pub size: u32,
        pub data: *mut u8,
    }

    #[link(name = "crypt32")]
    unsafe extern "system" {
        pub fn CryptProtectData(
            data_in: *const DataBlob,
            description: *const u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
        pub fn CryptUnprotectData(
            data_in: *const DataBlob,
            description: *mut *mut u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    pub const UI_FORBIDDEN: u32 = 0x1;
    pub const LOCAL_MACHINE: u32 = 0x4;
    pub const ENTROPY: &[u8] = b"ARTEPOOL device enrollment v1";

    pub fn run(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let data_in = DataBlob {
            size: input.len() as u32,
            data: input.as_ptr().cast_mut(),
        };
        let entropy = DataBlob {
            size: ENTROPY.len() as u32,
            data: ENTROPY.as_ptr().cast_mut(),
        };
        let mut out = DataBlob {
            size: 0,
            data: std::ptr::null_mut(),
        };
        let ok = unsafe {
            if protect {
                CryptProtectData(
                    &data_in,
                    std::ptr::null(),
                    &entropy,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    UI_FORBIDDEN | LOCAL_MACHINE,
                    &mut out,
                )
            } else {
                CryptUnprotectData(
                    &data_in,
                    std::ptr::null_mut(),
                    &entropy,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    UI_FORBIDDEN,
                    &mut out,
                )
            }
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let bytes = unsafe { std::slice::from_raw_parts_mut(out.data, out.size as usize) };
        let copy = bytes.to_vec();
        bytes.fill(0);
        unsafe { LocalFree(out.data.cast()) };
        Ok(copy)
    }
}

#[cfg(windows)]
impl Sealer for MachineDpapi {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        dpapi::run(plain, true)
    }
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        dpapi::run(sealed, false)
    }
}

/// Where this PC keeps its enrollment: the whole-PC file on the server PC (the launcher made
/// the folder, M6.4), otherwise the Windows account's Credential Manager (office PCs, laptop).
#[cfg(windows)]
pub enum PcStore {
    Machine(MachineStore<MachineDpapi>),
    Account(CredentialStore),
}

#[cfg(windows)]
impl SecretStore for PcStore {
    fn load(&self) -> Result<Option<StoredDevice>, StoreError> {
        match self {
            Self::Machine(store) => store.load(),
            Self::Account(store) => store.load(),
        }
    }
    fn save(&self, device: &StoredDevice) -> Result<(), StoreError> {
        match self {
            Self::Machine(store) => store.save(device),
            Self::Account(store) => store.save(device),
        }
    }
}

/// `C:\ProgramData\ARTEPOOL\device`: present only on the server PC.
#[cfg(windows)]
pub fn machine_folder() -> std::path::PathBuf {
    std::env::var_os("ProgramData")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\ProgramData"))
        .join("ARTEPOOL")
        .join("device")
}

/// On the server PC, moves an enrollment still kept in this Windows account (the owner's, from
/// before M6.4) to the whole-PC file. Returns whether it moved; elsewhere it does nothing.
#[cfg(windows)]
pub fn share_enrollment(service: &str, account: &str) -> Result<bool, StoreError> {
    let folder = machine_folder();
    if !folder.is_dir() {
        return Ok(false);
    }
    let credentials = CredentialStore::new(service, account)?;
    let machine = MachineStore::new(folder.join("enrollment.dat"), MachineDpapi);
    move_to_machine(&machine, &credentials, || credentials.forget())
}

/// Opens this PC's store: the whole-PC file on the server PC (after moving the account's copy
/// there), otherwise this Windows account's Credential Manager.
#[cfg(windows)]
pub fn pc_store(service: &str, account: &str) -> Result<PcStore, StoreError> {
    let folder = machine_folder();
    if !folder.is_dir() {
        return Ok(PcStore::Account(CredentialStore::new(service, account)?));
    }
    share_enrollment(service, account)?;
    Ok(PcStore::Machine(MachineStore::new(
        folder.join("enrollment.dat"),
        MachineDpapi,
    )))
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

    /// A reversible stand-in for DPAPI in the tests (not a protection).
    struct Flip;
    impl Sealer for Flip {
        fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
            Ok(plain.iter().map(|b| b ^ 0x5a).collect())
        }
        fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
            Ok(sealed.iter().map(|b| b ^ 0x5a).collect())
        }
    }

    fn temp_file(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("artepool-machine-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("enrollment.dat")
    }

    #[test]
    fn the_whole_pc_file_is_sealed_and_reads_back() {
        let file = temp_file("seal");
        let store = MachineStore::new(file.clone(), Flip);
        assert_eq!(store.load().unwrap(), None);
        store.save(&sample()).unwrap();
        assert_eq!(store.load().unwrap(), Some(sample()));
        let raw = std::fs::read(&file).unwrap();
        assert!(
            !String::from_utf8_lossy(&raw).contains("serverUrl"),
            "sealed on disk"
        );
        assert!(!file.with_extension("tmp").exists());
        std::fs::write(&file, b"garbage").unwrap();
        assert!(matches!(store.load(), Err(StoreError::Damaged(_))));
        std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }

    #[test]
    fn the_account_enrollment_moves_once_and_only_when_the_file_is_empty() {
        let machine = MemoryStore::default();
        let account = MemoryStore::with(sample());
        let mut forgotten = 0;
        assert!(
            move_to_machine(&machine, &account, || {
                forgotten += 1;
                Ok(())
            })
            .unwrap()
        );
        assert_eq!(machine.load().unwrap(), Some(sample()));
        assert_eq!(forgotten, 1);
        // Already there: nothing moves, the account is not touched again.
        assert!(!move_to_machine(&machine, &account, || panic!("not again")).unwrap());
        // Nothing in the account: nothing to move.
        let empty = MemoryStore::default();
        assert!(!move_to_machine(&MemoryStore::default(), &empty, || panic!("nothing")).unwrap());
    }

    #[test]
    fn the_account_copy_stays_if_the_file_cannot_be_written() {
        struct Broken;
        impl SecretStore for Broken {
            fn load(&self) -> Result<Option<StoredDevice>, StoreError> {
                Ok(None)
            }
            fn save(&self, _: &StoredDevice) -> Result<(), StoreError> {
                Err(StoreError::Unavailable("read-only".into()))
            }
        }
        let account = MemoryStore::with(sample());
        assert!(move_to_machine(&Broken, &account, || panic!("must not forget")).is_err());
        assert_eq!(account.load().unwrap(), Some(sample()));
    }

    #[cfg(windows)]
    #[test]
    fn the_whole_pc_file_is_sealed_with_the_pcs_own_key() {
        let file = temp_file("dpapi");
        let store = MachineStore::new(file.clone(), MachineDpapi);
        store.save(&sample()).unwrap();
        assert_eq!(store.load().unwrap(), Some(sample()));
        let raw = std::fs::read(&file).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("serverUrl"));
        // Bound to the enrollment: a blob made for anything else does not open as it.
        assert!(MachineDpapi.open(b"not a dpapi blob").is_err());
        std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
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
