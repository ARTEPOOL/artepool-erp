//! "ARTÉPOOL – Emergency tool" (decision 0107), in the Start menu of the server PC only.
//!
//! Windows asks for an administrator's permission before this starts (its manifest, see
//! build.rs), so a cashier's standard account cannot open it. It then opens the ARTÉPOOL app in
//! its emergency window, which inherits the administrator rights:
//!
//!   C:\Program Files\ARTEPOOL\artepool-emergency.exe
//!     → C:\Program Files\ARTEPOOL ERP\artepool-erp.exe --emergency
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::Command;

/// The app the desktop installer puts beside this program's folder.
fn app_beside(exe: &Path) -> Option<PathBuf> {
    Some(
        exe.parent()?
            .parent()?
            .join("ARTEPOOL ERP")
            .join("artepool-erp.exe"),
    )
}

/// The emergency window keeps its own browser data: an administrator's window cannot share it
/// with the app open at the same time without administrator rights.
fn webview_folder() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(Path::new(&base).join("ARTEPOOL").join("emergency-webview"))
}

const NOT_FOUND: &str = "تطبيق آرتيبول مش موجود على الجهاز ده. سطّب آرتيبول الأول.\n\nThe ARTEPOOL app is not installed on this PC. Install ARTEPOOL first.";
const NOT_STARTED: &str = "أداة الطوارئ ما اشتغلتش. ابعت فولدر C:\\ProgramData\\ARTEPOOL\\logs للدعم الفني.\n\nThe emergency tool did not start. Send the folder C:\\ProgramData\\ARTEPOOL\\logs to support.";

#[cfg(windows)]
fn tell(text: &str) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(window: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    const MB_ICONERROR: u32 = 0x10;
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (text, caption) = (wide(text), wide("ARTEPOOL"));
    unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), MB_ICONERROR) };
}

#[cfg(not(windows))]
fn tell(text: &str) {
    eprintln!("{text}");
}

fn main() {
    let Some(app) = std::env::current_exe()
        .ok()
        .and_then(|exe| app_beside(&exe))
        .filter(|app| app.is_file())
    else {
        tell(NOT_FOUND);
        std::process::exit(2);
    };
    let mut command = Command::new(&app);
    command.arg("--emergency");
    if let Some(folder) = webview_folder() {
        command.env("WEBVIEW2_USER_DATA_FOLDER", folder);
    }
    if command.spawn().is_err() {
        tell(NOT_STARTED);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_app_in_the_folder_beside_its_own() {
        let exe = Path::new("C:/Program Files/ARTEPOOL/artepool-emergency.exe");
        assert_eq!(
            app_beside(exe),
            Some(PathBuf::from(
                "C:/Program Files/ARTEPOOL ERP/artepool-erp.exe"
            ))
        );
        assert_eq!(app_beside(Path::new("artepool-emergency.exe")), None);
    }
}
