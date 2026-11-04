//! Windows calls for the cashier's account (see `cashier.rs` for the rules). Everything here is
//! present on every Windows 10/11 edition, Home included (decision 0106): netapi32 for the account
//! and its groups, the LSA for the secret, the registry for automatic sign-in and active hours,
//! and the security APIs to read folder and service rules. Run as administrator (or SYSTEM).

use std::ffi::{OsStr, c_void};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::process::Command;

use zeroize::Zeroizing;

use crate::cashier::{
    ACCOUNT, ACTIVE_HOURS_END, ACTIVE_HOURS_KEY, ACTIVE_HOURS_START, ADMINISTRATORS, COMMENT,
    DEVICE_FOLDER, ENROLLMENT_FILE, FULL_NAME, LSA_DEFAULT_PASSWORD, Observed, Rule, SERVICES,
    USERS, WINLOGON_KEY, WINLOGON_REMOVED, backup_dir_from_settings, closed_folders, folder_closed,
    folder_read_only, generate_password, icacls_device, icacls_reset, icacls_root, service_closed,
    standard_identities, winlogon_values,
};
use crate::{Layout, SvcError};

// ---- Declarations -------------------------------------------------------------------------

#[repr(C)]
struct UserInfo1 {
    name: *mut u16,
    password: *mut u16,
    password_age: u32,
    privilege: u32,
    home_dir: *mut u16,
    comment: *mut u16,
    flags: u32,
    script_path: *mut u16,
}

#[repr(C)]
struct UserInfo1003 {
    password: *mut u16,
}

#[repr(C)]
struct UserInfo1008 {
    flags: u32,
}

#[repr(C)]
struct UserInfo1011 {
    full_name: *mut u16,
}

#[repr(C)]
struct LocalGroupMembersInfo3 {
    domain_and_name: *mut u16,
}

#[repr(C)]
struct LocalGroupUsersInfo0 {
    name: *mut u16,
}

#[repr(C)]
struct LsaUnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[repr(C)]
struct LsaObjectAttributes {
    length: u32,
    root_directory: *mut c_void,
    object_name: *mut LsaUnicodeString,
    attributes: u32,
    security_descriptor: *mut c_void,
    security_quality_of_service: *mut c_void,
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

const USER_PRIV_USER: u32 = 1;
const UF_SCRIPT: u32 = 0x0001;
const UF_ACCOUNTDISABLE: u32 = 0x0002;
const UF_PASSWD_CANT_CHANGE: u32 = 0x0040;
const UF_DONT_EXPIRE_PASSWD: u32 = 0x1_0000;
const NERR_SUCCESS: u32 = 0;
const NERR_USER_NOT_FOUND: u32 = 2221;
const ERROR_MEMBER_NOT_IN_ALIAS: u32 = 1377;
const ERROR_MEMBER_IN_ALIAS: u32 = 1378;
const MAX_PREFERRED_LENGTH: u32 = u32::MAX;
const LG_INCLUDE_INDIRECT: u32 = 1;

const POLICY_GET_PRIVATE_INFORMATION: u32 = 0x0004;
const POLICY_CREATE_SECRET: u32 = 0x0020;
const STATUS_OBJECT_NAME_NOT_FOUND: i32 = 0xC000_0034_u32 as i32;

const HKEY_LOCAL_MACHINE: isize = 0x8000_0002_u32 as i32 as isize;
const KEY_READ: u32 = 0x2_0019;
const KEY_ALL_ACCESS: u32 = 0xF_003F;
const KEY_WOW64_64KEY: u32 = 0x0100;
const REG_SZ: u32 = 1;
const REG_DWORD: u32 = 4;
const ERROR_FILE_NOT_FOUND: i32 = 2;

const SE_FILE_OBJECT: u32 = 1;
const DACL_SECURITY_INFORMATION: u32 = 0x4;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;
const INHERIT_ONLY_ACE: u8 = 0x8;
const SC_MANAGER_CONNECT: u32 = 0x0001;
const READ_CONTROL: u32 = 0x2_0000;

#[link(name = "netapi32")]
unsafe extern "system" {
    fn NetUserAdd(server: *const u16, level: u32, buf: *const u8, parm_err: *mut u32) -> u32;
    fn NetUserGetInfo(server: *const u16, user: *const u16, level: u32, buf: *mut *mut u8) -> u32;
    fn NetUserSetInfo(
        server: *const u16,
        user: *const u16,
        level: u32,
        buf: *const u8,
        parm_err: *mut u32,
    ) -> u32;
    fn NetUserGetLocalGroups(
        server: *const u16,
        user: *const u16,
        level: u32,
        flags: u32,
        buf: *mut *mut u8,
        max_len: u32,
        read: *mut u32,
        total: *mut u32,
    ) -> u32;
    fn NetLocalGroupAddMembers(
        server: *const u16,
        group: *const u16,
        level: u32,
        buf: *const u8,
        count: u32,
    ) -> u32;
    fn NetLocalGroupDelMembers(
        server: *const u16,
        group: *const u16,
        level: u32,
        buf: *const u8,
        count: u32,
    ) -> u32;
    fn NetApiBufferFree(buf: *mut c_void) -> u32;
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn LsaOpenPolicy(
        system: *mut LsaUnicodeString,
        attributes: *mut LsaObjectAttributes,
        access: u32,
        handle: *mut *mut c_void,
    ) -> i32;
    fn LsaStorePrivateData(
        policy: *mut c_void,
        key: *mut LsaUnicodeString,
        data: *mut LsaUnicodeString,
    ) -> i32;
    fn LsaRetrievePrivateData(
        policy: *mut c_void,
        key: *mut LsaUnicodeString,
        data: *mut *mut LsaUnicodeString,
    ) -> i32;
    fn LsaFreeMemory(buffer: *mut c_void) -> i32;
    fn LsaClose(handle: *mut c_void) -> i32;
    fn LsaNtStatusToWinError(status: i32) -> u32;

    fn RegCreateKeyExW(
        key: isize,
        sub_key: *const u16,
        reserved: u32,
        class: *const u16,
        options: u32,
        sam: u32,
        security: *const c_void,
        result: *mut isize,
        disposition: *mut u32,
    ) -> i32;
    fn RegOpenKeyExW(
        key: isize,
        sub_key: *const u16,
        options: u32,
        sam: u32,
        result: *mut isize,
    ) -> i32;
    fn RegSetValueExW(
        key: isize,
        name: *const u16,
        reserved: u32,
        kind: u32,
        data: *const u8,
        size: u32,
    ) -> i32;
    fn RegQueryValueExW(
        key: isize,
        name: *const u16,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        size: *mut u32,
    ) -> i32;
    fn RegDeleteValueW(key: isize, name: *const u16) -> i32;
    fn RegCloseKey(key: isize) -> i32;

    fn ConvertStringSidToSidW(text: *const u16, sid: *mut *mut c_void) -> i32;
    fn ConvertSidToStringSidW(sid: *const c_void, text: *mut *mut u16) -> i32;
    fn LookupAccountSidW(
        system: *const u16,
        sid: *const c_void,
        name: *mut u16,
        name_len: *mut u32,
        domain: *mut u16,
        domain_len: *mut u32,
        kind: *mut u32,
    ) -> i32;
    fn LookupAccountNameW(
        system: *const u16,
        name: *const u16,
        sid: *mut c_void,
        sid_len: *mut u32,
        domain: *mut u16,
        domain_len: *mut u32,
        kind: *mut u32,
    ) -> i32;
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
    fn GetSecurityDescriptorDacl(
        descriptor: *const c_void,
        present: *mut i32,
        dacl: *mut *mut AclHeader,
        defaulted: *mut i32,
    ) -> i32;
    fn OpenSCManagerW(machine: *const u16, database: *const u16, access: u32) -> *mut c_void;
    fn OpenServiceW(manager: *mut c_void, name: *const u16, access: u32) -> *mut c_void;
    fn QueryServiceObjectSecurity(
        service: *mut c_void,
        info: u32,
        descriptor: *mut c_void,
        size: u32,
        needed: *mut u32,
    ) -> i32;
    fn CloseServiceHandle(handle: *mut c_void) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
    fn GetLastError() -> u32;
}

// ---- Small helpers ------------------------------------------------------------------------

fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain(Some(0)).collect()
}

/// A wide copy of a secret, wiped when dropped.
fn wide_secret(text: &str) -> Zeroizing<Vec<u16>> {
    Zeroizing::new(OsStr::new(text).encode_wide().chain(Some(0)).collect())
}

fn os_error(code: u32) -> String {
    std::io::Error::from_raw_os_error(code as i32).to_string()
}

fn net_error(what: &str, status: u32) -> SvcError {
    SvcError::Io(format!("{what}: {} (error {status})", os_error(status)))
}

/// Reads a NUL-ended wide string.
unsafe fn read_wide(text: *const u16) -> String {
    if text.is_null() {
        return String::new();
    }
    let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) })
}

fn sid_to_text(sid: *const c_void) -> Option<String> {
    let mut text: *mut u16 = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return None;
    }
    let value = unsafe { read_wide(text) };
    unsafe { LocalFree(text.cast()) };
    Some(value)
}

/// The local name of a well-known group (an Arabic Windows calls "Users" something else).
fn group_name(sid_text: &str) -> Result<String, SvcError> {
    let text = wide(sid_text);
    let mut sid: *mut c_void = std::ptr::null_mut();
    if unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut sid) } == 0 {
        return Err(SvcError::Io(format!("Unknown SID {sid_text}")));
    }
    let mut name = vec![0u16; 256];
    let mut domain = vec![0u16; 256];
    let (mut name_len, mut domain_len, mut kind) = (256u32, 256u32, 0u32);
    let ok = unsafe {
        LookupAccountSidW(
            std::ptr::null(),
            sid,
            name.as_mut_ptr(),
            &mut name_len,
            domain.as_mut_ptr(),
            &mut domain_len,
            &mut kind,
        )
    };
    let error = unsafe { GetLastError() };
    unsafe { LocalFree(sid) };
    if ok == 0 {
        return Err(SvcError::Io(format!(
            "The group {sid_text} could not be found: {}",
            os_error(error)
        )));
    }
    Ok(String::from_utf16_lossy(&name[..name_len as usize]))
}

/// The cashier account's SID as text, if the account exists.
fn account_sid() -> Option<String> {
    let name = wide(ACCOUNT);
    let mut sid = vec![0u8; 128];
    let mut domain = vec![0u16; 256];
    let (mut sid_len, mut domain_len, mut kind) = (128u32, 256u32, 0u32);
    let ok = unsafe {
        LookupAccountNameW(
            std::ptr::null(),
            name.as_ptr(),
            sid.as_mut_ptr().cast(),
            &mut sid_len,
            domain.as_mut_ptr(),
            &mut domain_len,
            &mut kind,
        )
    };
    if ok == 0 {
        return None;
    }
    sid_to_text(sid.as_ptr().cast())
}

fn computer_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| ".".into())
}

// ---- The account --------------------------------------------------------------------------

/// The account's flags, or None if there is no such account.
fn account_flags() -> Result<Option<u32>, SvcError> {
    let name = wide(ACCOUNT);
    let mut buf: *mut u8 = std::ptr::null_mut();
    let status = unsafe { NetUserGetInfo(std::ptr::null(), name.as_ptr(), 1, &mut buf) };
    if status == NERR_USER_NOT_FOUND {
        return Ok(None);
    }
    if status != NERR_SUCCESS {
        return Err(net_error("The cashier account could not be read", status));
    }
    let flags = unsafe { (*(buf as *const UserInfo1)).flags };
    unsafe { NetApiBufferFree(buf.cast()) };
    Ok(Some(flags))
}

/// The local groups the account is in, by SID.
fn account_groups() -> Result<Vec<String>, SvcError> {
    let name = wide(ACCOUNT);
    let mut buf: *mut u8 = std::ptr::null_mut();
    let (mut read, mut total) = (0u32, 0u32);
    let status = unsafe {
        NetUserGetLocalGroups(
            std::ptr::null(),
            name.as_ptr(),
            0,
            LG_INCLUDE_INDIRECT,
            &mut buf,
            MAX_PREFERRED_LENGTH,
            &mut read,
            &mut total,
        )
    };
    if status != NERR_SUCCESS {
        return Err(net_error(
            "The cashier account's groups could not be read",
            status,
        ));
    }
    let entries =
        unsafe { std::slice::from_raw_parts(buf as *const LocalGroupUsersInfo0, read as usize) };
    let names: Vec<String> = entries
        .iter()
        .map(|e| unsafe { read_wide(e.name) })
        .collect();
    unsafe { NetApiBufferFree(buf.cast()) };
    // Compare by SID: the names are in the PC's language.
    let users = group_name(USERS)?;
    let administrators = group_name(ADMINISTRATORS)?;
    Ok(names
        .into_iter()
        .filter_map(|n| {
            if n.eq_ignore_ascii_case(&users) || n == users {
                Some(USERS.to_string())
            } else if n.eq_ignore_ascii_case(&administrators) || n == administrators {
                Some(ADMINISTRATORS.to_string())
            } else {
                None
            }
        })
        .collect())
}

fn set_info(level: u32, buf: *const u8, what: &str) -> Result<(), SvcError> {
    let name = wide(ACCOUNT);
    let mut parm = 0u32;
    let status = unsafe { NetUserSetInfo(std::ptr::null(), name.as_ptr(), level, buf, &mut parm) };
    if status != NERR_SUCCESS {
        return Err(net_error(what, status));
    }
    Ok(())
}

fn group_members(group_sid: &str, add: bool) -> Result<(), SvcError> {
    let group = wide(&group_name(group_sid)?);
    let mut member = wide(&format!("{}\\{ACCOUNT}", computer_name()));
    let info = LocalGroupMembersInfo3 {
        domain_and_name: member.as_mut_ptr(),
    };
    let status = unsafe {
        let buf = (&info as *const LocalGroupMembersInfo3).cast();
        if add {
            NetLocalGroupAddMembers(std::ptr::null(), group.as_ptr(), 3, buf, 1)
        } else {
            NetLocalGroupDelMembers(std::ptr::null(), group.as_ptr(), 3, buf, 1)
        }
    };
    match status {
        NERR_SUCCESS | ERROR_MEMBER_IN_ALIAS | ERROR_MEMBER_NOT_IN_ALIAS => Ok(()),
        other => Err(net_error(
            "The cashier account's groups could not be set",
            other,
        )),
    }
}

/// Creates the account, or repairs it: a standard user, enabled, its password never expiring
/// and not changeable by the user, a new random password, its display name.
fn ensure_account(password: &str) -> Result<&'static str, SvcError> {
    let flags = UF_SCRIPT | UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE;
    let mut secret = wide_secret(password);
    let created = match account_flags()? {
        None => {
            let mut name = wide(ACCOUNT);
            let mut comment = wide(COMMENT);
            let info = UserInfo1 {
                name: name.as_mut_ptr(),
                password: secret.as_mut_ptr(),
                password_age: 0,
                privilege: USER_PRIV_USER,
                home_dir: std::ptr::null_mut(),
                comment: comment.as_mut_ptr(),
                flags,
                script_path: std::ptr::null_mut(),
            };
            let mut parm = 0u32;
            let status = unsafe {
                NetUserAdd(
                    std::ptr::null(),
                    1,
                    (&info as *const UserInfo1).cast(),
                    &mut parm,
                )
            };
            if status != NERR_SUCCESS {
                return Err(net_error(
                    "The cashier account could not be created",
                    status,
                ));
            }
            true
        }
        Some(current) => {
            let info = UserInfo1003 {
                password: secret.as_mut_ptr(),
            };
            set_info(
                1003,
                (&info as *const UserInfo1003).cast(),
                "The cashier account's password could not be set",
            )?;
            let info = UserInfo1008 {
                flags: (current & !UF_ACCOUNTDISABLE) | flags,
            };
            set_info(
                1008,
                (&info as *const UserInfo1008).cast(),
                "The cashier account could not be enabled",
            )?;
            false
        }
    };
    let mut full = wide(FULL_NAME);
    let info = UserInfo1011 {
        full_name: full.as_mut_ptr(),
    };
    set_info(
        1011,
        (&info as *const UserInfo1011).cast(),
        "The cashier account's name could not be set",
    )?;
    group_members(USERS, true)?;
    group_members(ADMINISTRATORS, false)?;
    Ok(if created {
        "account created"
    } else {
        "account repaired"
    })
}

fn disable_account() -> Result<(), SvcError> {
    if let Some(current) = account_flags()? {
        let info = UserInfo1008 {
            flags: current | UF_ACCOUNTDISABLE,
        };
        set_info(
            1008,
            (&info as *const UserInfo1008).cast(),
            "The cashier account could not be disabled",
        )?;
    }
    Ok(())
}

// ---- The LSA secret -----------------------------------------------------------------------

struct Policy(*mut c_void);

impl Drop for Policy {
    fn drop(&mut self) {
        unsafe { LsaClose(self.0) };
    }
}

fn open_policy(access: u32) -> Result<Policy, SvcError> {
    let mut attributes = LsaObjectAttributes {
        length: std::mem::size_of::<LsaObjectAttributes>() as u32,
        root_directory: std::ptr::null_mut(),
        object_name: std::ptr::null_mut(),
        attributes: 0,
        security_descriptor: std::ptr::null_mut(),
        security_quality_of_service: std::ptr::null_mut(),
    };
    let mut handle: *mut c_void = std::ptr::null_mut();
    let status =
        unsafe { LsaOpenPolicy(std::ptr::null_mut(), &mut attributes, access, &mut handle) };
    if status != 0 {
        return Err(SvcError::Io(format!(
            "The protected store (LSA) could not be opened: {}",
            os_error(unsafe { LsaNtStatusToWinError(status) })
        )));
    }
    Ok(Policy(handle))
}

/// A counted string over a wide buffer (without its NUL).
fn lsa_string(buffer: &mut [u16]) -> LsaUnicodeString {
    let chars = buffer.len().saturating_sub(1);
    LsaUnicodeString {
        length: (chars * 2) as u16,
        maximum_length: (buffer.len() * 2) as u16,
        buffer: buffer.as_mut_ptr(),
    }
}

/// Stores the password as the LSA secret Windows reads for automatic sign-in; `None` deletes it.
fn store_secret(password: Option<&str>) -> Result<(), SvcError> {
    let policy = open_policy(POLICY_CREATE_SECRET)?;
    let mut key_text = wide(LSA_DEFAULT_PASSWORD);
    let mut key = lsa_string(&mut key_text);
    let status = match password {
        Some(password) => {
            let mut value = wide_secret(password);
            let mut data = lsa_string(&mut value);
            unsafe { LsaStorePrivateData(policy.0, &mut key, &mut data) }
        }
        None => unsafe { LsaStorePrivateData(policy.0, &mut key, std::ptr::null_mut()) },
    };
    if status != 0 && !(password.is_none() && status == STATUS_OBJECT_NAME_NOT_FOUND) {
        return Err(SvcError::Io(format!(
            "The cashier password could not be kept in the protected store: {}",
            os_error(unsafe { LsaNtStatusToWinError(status) })
        )));
    }
    Ok(())
}

/// Whether the secret is there (its value is wiped and never leaves this function).
fn secret_present() -> bool {
    let Ok(policy) = open_policy(POLICY_GET_PRIVATE_INFORMATION) else {
        return false;
    };
    let mut key_text = wide(LSA_DEFAULT_PASSWORD);
    let mut key = lsa_string(&mut key_text);
    let mut data: *mut LsaUnicodeString = std::ptr::null_mut();
    let status = unsafe { LsaRetrievePrivateData(policy.0, &mut key, &mut data) };
    if status != 0 || data.is_null() {
        return false;
    }
    let present = unsafe { (*data).length } > 0;
    unsafe {
        let value = &*data;
        if !value.buffer.is_null() {
            std::ptr::write_bytes(value.buffer, 0, usize::from(value.length) / 2);
        }
        LsaFreeMemory(data.cast());
    }
    present
}

// ---- The registry -------------------------------------------------------------------------

struct Key(isize);

impl Drop for Key {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}

fn open_key(path: &str, write: bool) -> Result<Option<Key>, SvcError> {
    let name = wide(path);
    let mut key: isize = 0;
    let status = if write {
        unsafe {
            RegCreateKeyExW(
                HKEY_LOCAL_MACHINE,
                name.as_ptr(),
                0,
                std::ptr::null(),
                0,
                KEY_ALL_ACCESS | KEY_WOW64_64KEY,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        }
    } else {
        unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                name.as_ptr(),
                0,
                KEY_READ | KEY_WOW64_64KEY,
                &mut key,
            )
        }
    };
    if status == ERROR_FILE_NOT_FOUND && !write {
        return Ok(None);
    }
    if status != 0 {
        return Err(SvcError::Io(format!(
            "The registry key HKLM\\{path} could not be opened: {}",
            os_error(status as u32)
        )));
    }
    Ok(Some(Key(key)))
}

fn set_text(key: &Key, name: &str, value: &str) -> Result<(), SvcError> {
    let data = wide(value);
    let status = unsafe {
        RegSetValueExW(
            key.0,
            wide(name).as_ptr(),
            0,
            REG_SZ,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        )
    };
    if status != 0 {
        return Err(SvcError::Io(format!(
            "The registry value {name} could not be written: {}",
            os_error(status as u32)
        )));
    }
    Ok(())
}

fn set_number(key: &Key, name: &str, value: u32) -> Result<(), SvcError> {
    let status = unsafe {
        RegSetValueExW(
            key.0,
            wide(name).as_ptr(),
            0,
            REG_DWORD,
            (&value as *const u32).cast(),
            4,
        )
    };
    if status != 0 {
        return Err(SvcError::Io(format!(
            "The registry value {name} could not be written: {}",
            os_error(status as u32)
        )));
    }
    Ok(())
}

fn delete_value(key: &Key, name: &str) -> Result<(), SvcError> {
    let status = unsafe { RegDeleteValueW(key.0, wide(name).as_ptr()) };
    if status != 0 && status != ERROR_FILE_NOT_FOUND {
        return Err(SvcError::Io(format!(
            "The registry value {name} could not be removed: {}",
            os_error(status as u32)
        )));
    }
    Ok(())
}

enum RegValue {
    Text(String),
    Number(u32),
}

/// Whether a value is there at all, whatever its size or kind.
fn value_present(key: &Key, name: &str) -> bool {
    let (mut kind, mut size) = (0u32, 0u32);
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            wide(name).as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    status == 0
}

fn read_value(key: &Key, name: &str) -> Option<RegValue> {
    let mut buf = vec![0u8; 1024];
    let (mut kind, mut size) = (0u32, buf.len() as u32);
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            wide(name).as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            buf.as_mut_ptr(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    match kind {
        REG_DWORD if size == 4 => Some(RegValue::Number(u32::from_le_bytes([
            buf[0], buf[1], buf[2], buf[3],
        ]))),
        REG_SZ => {
            let units: Vec<u16> = buf[..size as usize]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .take_while(|&u| u != 0)
                .collect();
            Some(RegValue::Text(String::from_utf16_lossy(&units)))
        }
        _ => None,
    }
}

fn text_value(key: &Key, name: &str) -> Option<String> {
    match read_value(key, name)? {
        RegValue::Text(text) => Some(text),
        RegValue::Number(_) => None,
    }
}

fn number_value(key: &Key, name: &str) -> Option<u32> {
    match read_value(key, name)? {
        RegValue::Number(n) => Some(n),
        RegValue::Text(text) => text.trim().parse().ok(),
    }
}

fn set_auto_sign_in() -> Result<(), SvcError> {
    let key = open_key(WINLOGON_KEY, true)?.expect("a key opened for writing");
    for (name, value) in winlogon_values(&computer_name()) {
        set_text(&key, name, &value)?;
    }
    for name in WINLOGON_REMOVED {
        delete_value(&key, name)?;
    }
    Ok(())
}

/// Only when automatic sign-in is the cashier's: an owner's own setting is left as it is.
fn auto_sign_in_off() -> Result<bool, SvcError> {
    let key = open_key(WINLOGON_KEY, true)?.expect("a key opened for writing");
    if !text_value(&key, "DefaultUserName").is_some_and(|u| u.eq_ignore_ascii_case(ACCOUNT)) {
        return Ok(false);
    }
    set_text(&key, "AutoAdminLogon", "0")?;
    delete_value(&key, "DefaultPassword")?;
    Ok(true)
}

fn set_active_hours() -> Result<(), SvcError> {
    let key = open_key(ACTIVE_HOURS_KEY, true)?.expect("a key opened for writing");
    set_number(&key, "ActiveHoursStart", ACTIVE_HOURS_START)?;
    set_number(&key, "ActiveHoursEnd", ACTIVE_HOURS_END)?;
    // 0: the owner's hours, not hours Windows guesses from use.
    set_number(&key, "SmartActiveHoursState", 0)
}

// ---- Folder and service rules -------------------------------------------------------------

unsafe fn rules_of(dacl: *const AclHeader) -> Option<Vec<Rule>> {
    if dacl.is_null() {
        return None; // no rules at all: everyone may do anything
    }
    let count = unsafe { (*dacl).ace_count };
    let mut rules = Vec::with_capacity(usize::from(count));
    for index in 0..u32::from(count) {
        let mut ace: *mut AceHeader = std::ptr::null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
            return None;
        }
        let header = unsafe { &*ace };
        let allow = match header.ace_type {
            ACCESS_ALLOWED_ACE_TYPE => true,
            ACCESS_DENIED_ACE_TYPE => false,
            _ => continue,
        };
        // ACCESS_ALLOWED_ACE / ACCESS_DENIED_ACE: header (4 bytes), mask (4), then the SID.
        let mask = unsafe { std::ptr::read_unaligned(ace.cast::<u8>().add(4).cast::<u32>()) };
        let sid = sid_to_text(unsafe { ace.cast::<u8>().add(8) }.cast())?;
        rules.push(Rule {
            sid,
            mask,
            allow,
            inherit_only: header.flags & INHERIT_ONLY_ACE != 0,
        });
    }
    Some(rules)
}

/// A folder's rules; None when they cannot be read (counted as not closed).
fn folder_rules(path: &Path) -> Option<Vec<Rule>> {
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
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
        return None;
    }
    let rules = unsafe { rules_of(dacl) };
    unsafe { LocalFree(descriptor) };
    rules
}

fn service_rules(name: &str) -> Option<Vec<Rule>> {
    let manager = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) };
    if manager.is_null() {
        return None;
    }
    let service = unsafe { OpenServiceW(manager, wide(name).as_ptr(), READ_CONTROL) };
    let result = (|| {
        if service.is_null() {
            return None;
        }
        let mut needed = 0u32;
        unsafe {
            QueryServiceObjectSecurity(
                service,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        let mut buf = vec![0u8; needed.max(64) as usize];
        if unsafe {
            QueryServiceObjectSecurity(
                service,
                DACL_SECURITY_INFORMATION,
                buf.as_mut_ptr().cast(),
                buf.len() as u32,
                &mut needed,
            )
        } == 0
        {
            return None;
        }
        let (mut present, mut defaulted) = (0i32, 0i32);
        let mut dacl: *mut AclHeader = std::ptr::null_mut();
        if unsafe {
            GetSecurityDescriptorDacl(buf.as_ptr().cast(), &mut present, &mut dacl, &mut defaulted)
        } == 0
            || present == 0
        {
            return None;
        }
        unsafe { rules_of(dacl) }
    })();
    unsafe {
        if !service.is_null() {
            CloseServiceHandle(service);
        }
        CloseServiceHandle(manager);
    }
    result
}

fn icacls(args: &[String]) -> Result<(), SvcError> {
    let system = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let output = Command::new(Path::new(&system).join("System32").join("icacls.exe"))
        .args(args)
        .output()
        .map_err(|e| SvcError::Io(format!("icacls could not start: {e}")))?;
    if !output.status.success() {
        return Err(SvcError::Io(format!(
            "The access rules of {} could not be set: {}",
            args.first().map(String::as_str).unwrap_or(""),
            String::from_utf8_lossy(&output.stdout).trim()
        )));
    }
    Ok(())
}

/// The ARTEPOOL folder read-only for standard accounts, `updates` closed again, and the shared
/// enrollment folder (readable and changeable by standard accounts, nothing else).
fn close_folders(layout: &Layout) -> Result<(), SvcError> {
    icacls(&icacls_root(&layout.data_dir))?;
    let updates = layout.data_dir.join("updates");
    if updates.is_dir() {
        icacls(&icacls_reset(&updates))?;
    }
    let device = layout.data_dir.join(DEVICE_FOLDER);
    std::fs::create_dir_all(&device)
        .map_err(|e| SvcError::Io(format!("Could not create {}: {e}", device.display())))?;
    icacls(&icacls_device(&device))
}

fn backup_dir(layout: &Layout) -> Option<std::path::PathBuf> {
    backup_dir_from_settings(&std::fs::read_to_string(layout.config_file()).ok()?)
}

// ---- The three commands -------------------------------------------------------------------

/// `check`: what is on the PC now. Run as administrator or SYSTEM (the LSA secret).
pub fn observe(layout: &Layout) -> Result<Observed, SvcError> {
    let Some(flags) = account_flags()? else {
        return Ok(Observed::default());
    };
    let groups = account_groups()?;
    let cashier_sid = account_sid();
    let who = standard_identities(cashier_sid.as_deref());
    let winlogon = open_key(WINLOGON_KEY, false)?;
    let auto_sign_in = winlogon.as_ref().is_some_and(|key| {
        text_value(key, "AutoAdminLogon").as_deref() == Some("1")
            && text_value(key, "DefaultUserName").is_some_and(|u| u.eq_ignore_ascii_case(ACCOUNT))
    });
    let plain_password = winlogon
        .as_ref()
        .is_some_and(|key| value_present(key, "DefaultPassword"));
    let active_hours = open_key(ACTIVE_HOURS_KEY, false)?.is_some_and(|key| {
        number_value(&key, "ActiveHoursStart") == Some(ACTIVE_HOURS_START)
            && number_value(&key, "ActiveHoursEnd") == Some(ACTIVE_HOURS_END)
            && number_value(&key, "SmartActiveHoursState") != Some(1)
    });
    let open_folders = closed_folders(layout, backup_dir(layout))
        .into_iter()
        .filter(|folder| folder.exists())
        .filter(|folder| !folder_rules(folder).is_some_and(|rules| folder_closed(&rules, &who)))
        .map(|folder| folder.display().to_string())
        .collect();
    let root_read_only =
        folder_rules(&layout.data_dir).is_some_and(|rules| folder_read_only(&rules, &who));
    let open_services = SERVICES
        .iter()
        .filter(|name| !service_rules(name).is_some_and(|rules| service_closed(&rules, &who)))
        .map(|name| name.to_string())
        .collect();
    Ok(Observed {
        account_exists: true,
        enabled: flags & UF_ACCOUNTDISABLE == 0,
        never_expires: flags & UF_DONT_EXPIRE_PASSWD != 0,
        in_users: groups.iter().any(|g| g == USERS),
        in_administrators: groups.iter().any(|g| g == ADMINISTRATORS),
        auto_sign_in,
        secret_stored: secret_present(),
        plain_password,
        active_hours,
        enrollment_shared: layout
            .data_dir
            .join(DEVICE_FOLDER)
            .join(ENROLLMENT_FILE)
            .is_file(),
        open_folders,
        root_read_only,
        open_services,
    })
}

/// `setup`: set up or repair, every step every time (safe to run again). Returns what was done.
pub fn setup(layout: &Layout) -> Result<Vec<&'static str>, SvcError> {
    let password = generate_password()?;
    let mut done = vec![ensure_account(&password)?];
    store_secret(Some(&password))?;
    drop(password);
    done.push("password kept in the protected store");
    set_auto_sign_in()?;
    done.push("automatic sign-in");
    close_folders(layout)?;
    done.push("folders closed to standard accounts; shared enrollment folder");
    set_active_hours()?;
    done.push("active hours 08:00-24:00");
    Ok(done)
}

/// `disable` (uninstall): automatic sign-in off, the secret deleted, the account disabled.
pub fn disable() -> Result<Vec<&'static str>, SvcError> {
    let mut done = Vec::new();
    if auto_sign_in_off()? {
        done.push("automatic sign-in off");
        // The secret is the cashier's only while automatic sign-in is theirs.
        store_secret(None)?;
        done.push("password removed from the protected store");
    }
    if account_flags()?.is_some() {
        disable_account()?;
        done.push("account disabled");
    }
    Ok(done)
}
