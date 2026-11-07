//! The PDF copy of every thermal receipt (decision 0120). The screens make the PDF from the same
//! image the printer gets; this module only checks it and writes it into the PC's Public Documents,
//! `ARTEPOOL\Receipts\<YYYY-MM>\<number> - DD-MM-YYYY.pdf`, so every Windows account on the PC
//! (the owner's and the cashier's) finds it. One file per document: an existing copy is never
//! overwritten, so a reprint only puts back a missing file.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// Largest copy accepted (a long receipt's PDF is well under 1 MB).
pub const MAX_PDF_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CopyError {
    #[error("The receipt copy's name is not valid")]
    InvalidName,
    #[error("The receipt copy is not a PDF, or it is too large")]
    InvalidPdf,
    #[error("The Public Documents folder of this PC was not found")]
    NoFolder,
    #[error("The receipt copy could not be written: {0}")]
    Write(String),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Saved {
    /// Written now, at this path.
    Written(PathBuf),
    /// That document already has its copy: left as it is.
    Exists,
}

/// `YYYY-MM`, a real month.
pub fn valid_month(month: &str) -> bool {
    let b = month.as_bytes();
    b.len() == 7
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && matches!((b[5], b[6]), (b'0', b'1'..=b'9') | (b'1', b'0'..=b'2'))
}

/// `<number> - DD-MM-YYYY.pdf`: the number is a series prefix and digits (`POS-000123`,
/// `CN-000004`); nothing that could leave the folder or confuse Windows.
pub fn valid_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".pdf") else {
        return false;
    };
    let Some((number, date)) = stem.split_once(" - ") else {
        return false;
    };
    let number_ok = (1..=32).contains(&number.len())
        && number.as_bytes()[0].is_ascii_alphanumeric()
        && number
            .bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'-')
        && number.bytes().any(|c| c.is_ascii_digit());
    let d = date.as_bytes();
    let date_ok = d.len() == 10
        && d.iter().enumerate().all(|(i, c)| match i {
            2 | 5 => *c == b'-',
            _ => c.is_ascii_digit(),
        });
    number_ok && date_ok
}

/// The folder all copies go under: `<Public Documents>\ARTEPOOL\Receipts`.
pub fn receipts_root() -> Result<PathBuf, CopyError> {
    public_documents()
        .map(|documents| documents.join("ARTEPOOL").join("Receipts"))
        .ok_or(CopyError::NoFolder)
}

#[cfg(windows)]
fn public_documents() -> Option<PathBuf> {
    // %PUBLIC% is C:\Users\Public on every Windows 10/11 edition.
    std::env::var_os("PUBLIC").map(|public| PathBuf::from(public).join("Documents"))
}

#[cfg(not(windows))]
fn public_documents() -> Option<PathBuf> {
    // Development only: ARTEPOOL_PUBLIC_DOCUMENTS, else the home folder's Documents.
    std::env::var_os("ARTEPOOL_PUBLIC_DOCUMENTS")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Documents")))
}

/// Writes the copy under `root\<month>\<file name>`, unless it is already there. Written to a
/// temporary file first and then renamed, so a half-written copy never carries the real name.
pub fn save(root: &Path, month: &str, file_name: &str, pdf: &[u8]) -> Result<Saved, CopyError> {
    if !valid_month(month) || !valid_file_name(file_name) {
        return Err(CopyError::InvalidName);
    }
    if pdf.len() > MAX_PDF_BYTES || !pdf.starts_with(b"%PDF-") {
        return Err(CopyError::InvalidPdf);
    }
    let folder = root.join(month);
    let path = folder.join(file_name);
    if path.exists() {
        return Ok(Saved::Exists);
    }
    fs::create_dir_all(&folder).map_err(|e| CopyError::Write(e.to_string()))?;
    let temporary = folder.join(format!(".{file_name}.part"));
    let written = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(pdf)?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(CopyError::Write(error.to_string()));
    }
    if path.exists() {
        // Another copy of the same receipt landed meanwhile: keep that one.
        let _ = fs::remove_file(&temporary);
        return Ok(Saved::Exists);
    }
    fs::rename(&temporary, &path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        CopyError::Write(e.to_string())
    })?;
    Ok(Saved::Written(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "artepool-receipt-copy-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    const PDF: &[u8] = b"%PDF-1.4\n...\n%%EOF\n";

    #[test]
    fn months_and_names() {
        assert!(valid_month("2026-11"));
        assert!(valid_month("2027-01"));
        for bad in ["2026-13", "2026-00", "2026-1", "26-11", "2026/11", "..", ""] {
            assert!(!valid_month(bad), "{bad}");
        }
        assert!(valid_file_name("POS-000123 - 05-11-2026.pdf"));
        assert!(valid_file_name("CN-000004 - 30-11-2026.pdf"));
        for bad in [
            "POS-000123 - 05-11-2026.PDF",
            "POS-000123.pdf",
            "../POS-000123 - 05-11-2026.pdf",
            "POS-000123\\x - 05-11-2026.pdf",
            "pos-000123 - 05-11-2026.pdf",
            "POS- - 05-11-2026.pdf",
            "-POS1 - 05-11-2026.pdf",
            "POS-000123 - 5-11-2026.pdf",
            "POS-000123 - 05/11/2026.pdf",
            "POS-000123 - 05-11-2026.pdf.exe",
            "",
        ] {
            assert!(!valid_file_name(bad), "{bad}");
        }
    }

    #[test]
    fn writes_once_and_never_overwrites() {
        let root = scratch("once");
        let name = "POS-000123 - 05-11-2026.pdf";
        let first = save(&root, "2026-11", name, PDF).unwrap();
        let path = root.join("2026-11").join(name);
        assert_eq!(first, Saved::Written(path.clone()));
        assert_eq!(fs::read(&path).unwrap(), PDF);
        // A reprint (marked as a copy) never replaces the original's file.
        let again = save(&root, "2026-11", name, b"%PDF-1.4 other").unwrap();
        assert_eq!(again, Saved::Exists);
        assert_eq!(fs::read(&path).unwrap(), PDF);
        // A missing file is put back.
        fs::remove_file(&path).unwrap();
        assert!(matches!(
            save(&root, "2026-11", name, PDF).unwrap(),
            Saved::Written(_)
        ));
        // No temporary file is left behind.
        let left: Vec<_> = fs::read_dir(root.join("2026-11")).unwrap().collect();
        assert_eq!(left.len(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn refuses_bad_names_and_non_pdf() {
        let root = scratch("refuse");
        assert_eq!(
            save(&root, "../x", "POS-1 - 05-11-2026.pdf", PDF),
            Err(CopyError::InvalidName)
        );
        assert_eq!(
            save(&root, "2026-11", "../../evil.pdf", PDF),
            Err(CopyError::InvalidName)
        );
        assert_eq!(
            save(&root, "2026-11", "POS-1 - 05-11-2026.pdf", b"MZ not a pdf"),
            Err(CopyError::InvalidPdf)
        );
        let huge = [b"%PDF-".as_slice(), &vec![0u8; MAX_PDF_BYTES]].concat();
        assert_eq!(
            save(&root, "2026-11", "POS-1 - 05-11-2026.pdf", &huge),
            Err(CopyError::InvalidPdf)
        );
        assert!(!root.exists(), "nothing is created for a refused copy");
    }
}
