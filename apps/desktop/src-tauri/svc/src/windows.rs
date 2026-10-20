//! Windows: DPAPI for the machine (crypt32), and the folder and file access rules (advapi32).

use crate::{AccessCheck, Protector, Secret, SvcError, entropy};
use std::ffi::{OsStr, c_void};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

#[repr(C)]
struct DataBlob {
    size: u32,
    data: *mut u8,
}

#[repr(C)]
struct AclHeader {
    revision: u8,
    sbz1: u8,
    size: u16,
    ace_count: u16,
    sbz2: u16,
}

#[repr(C)]
struct AceHeader {
    ace_type: u8,
    flags: u8,
    size: u16,
}

#[repr(C)]
struct SecurityAttributes {
    length: u32,
    descriptor: *mut c_void,
    inherit: i32,
}

const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;
const CRYPTPROTECT_LOCAL_MACHINE: u32 = 0x4;
const SE_FILE_OBJECT: u32 = 1;
const DACL_SECURITY_INFORMATION: u32 = 0x4;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_ALLOWED_OBJECT_ACE_TYPE: u8 = 5;
const ACCESS_ALLOWED_CALLBACK_ACE_TYPE: u8 = 9;
const ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE: u8 = 11;
const INHERIT_ONLY_ACE: u8 = 0x8;
const SDDL_REVISION_1: u32 = 1;

#[link(name = "crypt32")]
unsafe extern "system" {
    fn CryptProtectData(
        data_in: *const DataBlob,
        description: *const u16,
        entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
    fn CryptUnprotectData(
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
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
    fn GetLastError() -> u32;
    fn CreateDirectoryW(path: *const u16, attributes: *const SecurityAttributes) -> i32;
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn GetNamedSecurityInfoW(
        object_name: *const u16,
        object_type: u32,
        info: u32,
        owner: *mut *mut c_void,
        group: *mut *mut c_void,
        dacl: *mut *mut AclHeader,
        sacl: *mut *mut c_void,
        descriptor: *mut *mut c_void,
    ) -> u32;
    fn GetAce(acl: *const AclHeader, index: u32, ace: *mut *mut AceHeader) -> i32;
    fn ConvertSidToStringSidW(sid: *const c_void, text: *mut *mut u16) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        text: *const u16,
        revision: u32,
        descriptor: *mut *mut c_void,
        size: *mut u32,
    ) -> i32;
}

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(std::iter::once(0)).collect()
}

fn last_error() -> String {
    let code = unsafe { GetLastError() };
    std::io::Error::from_raw_os_error(code as i32).to_string()
}

/// Copies DPAPI's output and wipes and frees its buffer.
unsafe fn take(blob: DataBlob) -> Zeroizing<Vec<u8>> {
    let bytes = unsafe { std::slice::from_raw_parts_mut(blob.data, blob.size as usize) };
    let copy = Zeroizing::new(bytes.to_vec());
    bytes.fill(0);
    unsafe { LocalFree(blob.data.cast()) };
    copy
}

/// DPAPI with the machine's key: the blob opens on this PC only, for any account on it, so the
/// folder's access rules decide who can read it. Each blob is bound to its secret's name.
pub struct Dpapi;

impl Protector for Dpapi {
    fn protect(&self, secret: &Secret, plain: &[u8]) -> Result<Vec<u8>, String> {
        let mut extra = entropy(secret);
        let input = DataBlob {
            size: plain.len() as u32,
            data: plain.as_ptr().cast_mut(),
        };
        let salt = DataBlob {
            size: extra.len() as u32,
            data: extra.as_mut_ptr(),
        };
        let mut output = DataBlob {
            size: 0,
            data: std::ptr::null_mut(),
        };
        let description = wide(OsStr::new(&format!("ARTEPOOL {}", secret.name)));
        let ok = unsafe {
            CryptProtectData(
                &input,
                description.as_ptr(),
                &salt,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        Ok(unsafe { take(output) }.to_vec())
    }

    fn unprotect(&self, secret: &Secret, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
        let mut extra = entropy(secret);
        let input = DataBlob {
            size: sealed.len() as u32,
            data: sealed.as_ptr().cast_mut(),
        };
        let salt = DataBlob {
            size: extra.len() as u32,
            data: extra.as_mut_ptr(),
        };
        let mut output = DataBlob {
            size: 0,
            data: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &salt,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        Ok(unsafe { take(output) })
    }
}

/// Who may open the secrets: SYSTEM, Administrators, and Windows service accounts
/// (`NT SERVICE\…`, whose SIDs start with S-1-5-80-).
pub fn allowed_sid(sid: &str) -> bool {
    sid == "S-1-5-18" || sid == "S-1-5-32-544" || sid.starts_with("S-1-5-80-")
}

/// Reads the access rules (DACL) of a file or folder and refuses any "allow" rule for anyone else.
pub struct WindowsAccess;

impl AccessCheck for WindowsAccess {
    fn check(&self, path: &Path) -> Result<(), SvcError> {
        let shown = path.display().to_string();
        let unknown = |why: String| SvcError::AccessUnknown(shown.clone(), why);
        let name = wide(path.as_os_str());
        let mut dacl: *mut AclHeader = std::ptr::null_mut();
        let mut descriptor: *mut c_void = std::ptr::null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(unknown(
                std::io::Error::from_raw_os_error(status as i32).to_string(),
            ));
        }
        let result = (|| {
            if dacl.is_null() {
                // No rules at all means everyone may open it.
                return Err(SvcError::TooOpen(
                    shown.clone(),
                    "everyone (no access rules)".into(),
                ));
            }
            let count = unsafe { (*dacl).ace_count };
            for index in 0..u32::from(count) {
                let mut ace: *mut AceHeader = std::ptr::null_mut();
                if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
                    return Err(unknown(last_error()));
                }
                let header = unsafe { &*ace };
                if header.flags & INHERIT_ONLY_ACE != 0 {
                    continue; // applies to new files only; those are checked themselves
                }
                match header.ace_type {
                    ACCESS_ALLOWED_ACE_TYPE | ACCESS_ALLOWED_CALLBACK_ACE_TYPE => {
                        // ACCESS_ALLOWED_ACE: header (4 bytes), mask (4), then the SID.
                        let sid = unsafe { ace.cast::<u8>().add(8) };
                        let mut text: *mut u16 = std::ptr::null_mut();
                        if unsafe { ConvertSidToStringSidW(sid.cast(), &mut text) } == 0 {
                            return Err(unknown(last_error()));
                        }
                        let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
                        let sid_text = String::from_utf16_lossy(unsafe {
                            std::slice::from_raw_parts(text, len)
                        });
                        unsafe { LocalFree(text.cast()) };
                        if !allowed_sid(&sid_text) {
                            return Err(SvcError::TooOpen(shown.clone(), sid_text));
                        }
                    }
                    ACCESS_ALLOWED_OBJECT_ACE_TYPE | ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE => {
                        return Err(SvcError::TooOpen(
                            shown.clone(),
                            "an unexpected object rule".into(),
                        ));
                    }
                    _ => {} // deny and audit rules never widen access
                }
            }
            Ok(())
        })();
        unsafe { LocalFree(descriptor) };
        result
    }
}

/// Creates a folder that only SYSTEM and Administrators may open (protected: nothing inherited
/// from ProgramData). The installer then adds the service accounts.
pub fn create_private_dir(path: &Path) -> Result<(), SvcError> {
    let sddl = wide(OsStr::new("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"));
    let mut descriptor: *mut c_void = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(SvcError::Io(format!(
            "Could not prepare the folder's access rules: {}",
            last_error()
        )));
    }
    let attributes = SecurityAttributes {
        length: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor,
        inherit: 0,
    };
    let name = wide(path.as_os_str());
    let ok = unsafe { CreateDirectoryW(name.as_ptr(), &attributes) };
    let error = if ok == 0 { Some(last_error()) } else { None };
    unsafe { LocalFree(descriptor) };
    match error {
        Some(why) => Err(SvcError::Io(format!(
            "Could not create {}: {why}",
            path.display()
        ))),
        None => Ok(()),
    }
}

/// `C:\ProgramData\ARTEPOOL`.
pub fn default_data_dir() -> PathBuf {
    let base = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    base.join("ARTEPOOL")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SECRETS, init, load, secret_named};

    fn fresh(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("artepool-svc-win-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn dpapi_round_trip_bound_to_the_secret_name() {
        let api = secret_named("api-password").unwrap();
        let backup = secret_named("backup-password").unwrap();
        let sealed = Dpapi.protect(&api, b"a-database-password-123").unwrap();
        assert!(!sealed.windows(8).any(|w| w == b"database"));
        assert_eq!(
            Dpapi.unprotect(&api, &sealed).unwrap().as_slice(),
            b"a-database-password-123"
        );
        assert!(Dpapi.unprotect(&backup, &sealed).is_err());
        let mut changed = sealed.clone();
        let last = changed.len() - 1;
        changed[last] ^= 1;
        assert!(Dpapi.unprotect(&api, &changed).is_err());
    }

    #[test]
    fn a_folder_the_signed_in_user_can_open_is_refused() {
        let dir = fresh("open");
        std::fs::create_dir_all(&dir).unwrap(); // inherits the user's own access from %TEMP%
        let err = WindowsAccess.check(&dir).unwrap_err();
        assert!(matches!(err, SvcError::TooOpen(..)), "{err}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_private_folder_passes_and_its_secrets_load() {
        let dir = fresh("private");
        create_private_dir(&dir).unwrap();
        WindowsAccess.check(&dir).unwrap();
        init(&dir, &Dpapi, &WindowsAccess).unwrap();
        let loaded = load(&dir, &Dpapi, &WindowsAccess).unwrap();
        assert_eq!(loaded.len(), SECRETS.len());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
