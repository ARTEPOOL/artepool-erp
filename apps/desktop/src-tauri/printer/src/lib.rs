//! Silent receipt printing (decisions 0008, 0055). The screens draw the receipt as an image and
//! turn it into ESC/POS bytes; this crate only sends those bytes, unchanged, to the printer chosen
//! for this PC — RAW through the Windows spooler, so no print dialog ever opens and Arabic prints
//! correctly on any 80 mm ESC/POS printer. The cash drawer, wired to the printer (RJ11), opens with
//! the drawer-kick bytes inside the same job.
//!
//! On other systems (development only) a "printer" is a folder: `ARTEPOOL_PRINTER_DIR` holds one
//! `<name>.bin` file per printer, and each job is appended to it, so tests can read what was sent.

use std::path::PathBuf;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PrintError {
    #[error("No printer is chosen for receipts on this PC")]
    NoPrinter,
    #[error("The printer name is not valid")]
    InvalidName,
    #[error("The print job is empty or too large")]
    InvalidJob,
    #[error("The printer could not be reached: {0}")]
    Unavailable(String),
}

/// Largest job accepted (a long receipt is about 200 KB).
pub const MAX_JOB_BYTES: usize = 4 * 1024 * 1024;

fn check_name(name: &str) -> Result<(), PrintError> {
    if name.trim().is_empty() {
        return Err(PrintError::NoPrinter);
    }
    if name.len() > 256 || name.contains('\0') || name.contains('/') || name.contains("..") {
        return Err(PrintError::InvalidName);
    }
    Ok(())
}

fn check_job(bytes: &[u8]) -> Result<(), PrintError> {
    if bytes.is_empty() || bytes.len() > MAX_JOB_BYTES {
        return Err(PrintError::InvalidJob);
    }
    Ok(())
}

/// The printers this PC can print to (local and shared), by name.
pub fn list_printers() -> Result<Vec<String>, PrintError> {
    imp::list()
}

/// Sends one job to the named printer as RAW bytes (no driver rendering, no dialog).
pub fn send_raw(printer: &str, document_name: &str, bytes: &[u8]) -> Result<(), PrintError> {
    check_name(printer)?;
    check_job(bytes)?;
    imp::send(printer, document_name, bytes)
}

/// The folder that stands for printers on systems other than Windows.
pub fn file_printer_dir() -> Option<PathBuf> {
    std::env::var_os("ARTEPOOL_PRINTER_DIR").map(PathBuf::from)
}

#[cfg(windows)]
mod imp {
    //! The Windows spooler (winspool.drv): OpenPrinter → StartDocPrinter("RAW") → WritePrinter.
    use super::PrintError;
    use std::ffi::c_void;

    #[repr(C)]
    struct DocInfo1 {
        doc_name: *mut u16,
        output_file: *mut u16,
        datatype: *mut u16,
    }

    #[repr(C)]
    struct PrinterInfo4 {
        printer_name: *mut u16,
        server_name: *mut u16,
        attributes: u32,
    }

    const PRINTER_ENUM_LOCAL: u32 = 0x2;
    const PRINTER_ENUM_CONNECTIONS: u32 = 0x4;

    #[link(name = "winspool")]
    unsafe extern "system" {
        fn EnumPrintersW(
            flags: u32,
            name: *const u16,
            level: u32,
            buffer: *mut u8,
            size: u32,
            needed: *mut u32,
            returned: *mut u32,
        ) -> i32;
        fn OpenPrinterW(name: *const u16, handle: *mut isize, defaults: *const c_void) -> i32;
        fn StartDocPrinterW(handle: isize, level: u32, info: *const DocInfo1) -> u32;
        fn StartPagePrinter(handle: isize) -> i32;
        fn WritePrinter(handle: isize, buffer: *const c_void, size: u32, written: *mut u32) -> i32;
        fn EndPagePrinter(handle: isize) -> i32;
        fn EndDocPrinter(handle: isize) -> i32;
        fn ClosePrinter(handle: isize) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_error() -> PrintError {
        PrintError::Unavailable(std::io::Error::last_os_error().to_string())
    }

    unsafe fn from_wide(p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let mut len = 0;
        // SAFETY: the spooler returns NUL-terminated strings inside the buffer it filled.
        unsafe {
            while *p.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
        }
    }

    pub fn list() -> Result<Vec<String>, PrintError> {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed = 0u32;
        let mut returned = 0u32;
        // SAFETY: the first call only asks for the size needed.
        unsafe {
            EnumPrintersW(flags, std::ptr::null(), 4, std::ptr::null_mut(), 0, &mut needed, &mut returned);
        }
        if needed == 0 {
            return Ok(Vec::new());
        }
        // u64 storage keeps the buffer aligned for the structures the spooler writes into it.
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
        // SAFETY: the buffer is at least `needed` bytes and aligned.
        let ok = unsafe {
            EnumPrintersW(
                flags,
                std::ptr::null(),
                4,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
                &mut returned,
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        let infos = buffer.as_ptr().cast::<PrinterInfo4>();
        let mut names = Vec::with_capacity(returned as usize);
        for i in 0..returned as usize {
            // SAFETY: the spooler wrote `returned` PRINTER_INFO_4W structures at the start.
            let name = unsafe { from_wide((*infos.add(i)).printer_name) };
            if !name.is_empty() {
                names.push(name);
            }
        }
        names.sort();
        Ok(names)
    }

    pub fn send(printer: &str, document_name: &str, bytes: &[u8]) -> Result<(), PrintError> {
        let name = wide(printer);
        let mut doc = wide(document_name);
        let mut datatype = wide("RAW");
        let mut handle: isize = 0;
        // SAFETY: valid NUL-terminated wide strings; the handle is closed on every path below.
        unsafe {
            if OpenPrinterW(name.as_ptr(), &mut handle, std::ptr::null()) == 0 {
                return Err(last_error());
            }
            let info = DocInfo1 {
                doc_name: doc.as_mut_ptr(),
                output_file: std::ptr::null_mut(),
                datatype: datatype.as_mut_ptr(),
            };
            let result = (|| {
                if StartDocPrinterW(handle, 1, &info) == 0 {
                    return Err(last_error());
                }
                let mut page = Ok(());
                if StartPagePrinter(handle) == 0 {
                    page = Err(last_error());
                } else {
                    let mut written = 0u32;
                    let ok = WritePrinter(handle, bytes.as_ptr().cast(), bytes.len() as u32, &mut written);
                    if ok == 0 {
                        page = Err(last_error());
                    } else if written as usize != bytes.len() {
                        page = Err(PrintError::Unavailable("the printer took only part of the job".into()));
                    }
                    EndPagePrinter(handle);
                }
                EndDocPrinter(handle);
                page
            })();
            ClosePrinter(handle);
            result
        }
    }
}

#[cfg(not(windows))]
mod imp {
    //! Development only: a printer is a file in `ARTEPOOL_PRINTER_DIR`.
    use super::{PrintError, file_printer_dir};
    use std::io::Write as _;

    pub fn list() -> Result<Vec<String>, PrintError> {
        let Some(dir) = file_printer_dir() else { return Ok(Vec::new()) };
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .map_err(|e| PrintError::Unavailable(e.to_string()))?
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter_map(|n| n.strip_suffix(".bin").map(str::to_owned))
            .collect();
        names.sort();
        Ok(names)
    }

    pub fn send(printer: &str, _document_name: &str, bytes: &[u8]) -> Result<(), PrintError> {
        let dir = file_printer_dir().ok_or_else(|| PrintError::Unavailable("no printer folder".into()))?;
        let path = dir.join(format!("{printer}.bin"));
        if !path.exists() {
            return Err(PrintError::Unavailable(format!("no printer named {printer}")));
        }
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .map_err(|e| PrintError::Unavailable(e.to_string()))?;
        file.write_all(bytes).map_err(|e| PrintError::Unavailable(e.to_string()))
    }
}
