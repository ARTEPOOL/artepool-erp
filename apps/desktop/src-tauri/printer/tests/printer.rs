//! The RAW sender: bytes reach the printer exactly as given; bad names and empty jobs are refused.
#![cfg(not(windows))]

use artepool_printer::{PrintError, list_printers, send_raw};

#[test]
fn sends_the_bytes_unchanged_and_refuses_bad_jobs() {
    let dir = std::env::temp_dir().join(format!("artepool-printer-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("TM-T20III.bin"), b"").unwrap();
    // SAFETY: this test is the only one in this binary that touches the environment.
    unsafe { std::env::set_var("ARTEPOOL_PRINTER_DIR", &dir) };

    assert_eq!(list_printers().unwrap(), vec!["TM-T20III".to_string()]);

    // ESC @, a raster byte, drawer kick (ESC p 0 25 250), cut (GS V 66 3).
    let job = [
        0x1b, 0x40, 0xff, 0x1b, 0x70, 0x00, 0x19, 0xfa, 0x1d, 0x56, 0x42, 0x03,
    ];
    send_raw("TM-T20III", "POS-000001", &job).unwrap();
    send_raw("TM-T20III", "POS-000002", &job[..2]).unwrap();
    let written = std::fs::read(dir.join("TM-T20III.bin")).unwrap();
    assert_eq!(&written[..job.len()], &job);
    assert_eq!(&written[job.len()..], &job[..2]);

    assert_eq!(send_raw("", "x", &job), Err(PrintError::NoPrinter));
    assert_eq!(send_raw("../etc", "x", &job), Err(PrintError::InvalidName));
    assert_eq!(send_raw("TM-T20III", "x", &[]), Err(PrintError::InvalidJob));
    assert!(matches!(
        send_raw("Missing", "x", &job),
        Err(PrintError::Unavailable(_))
    ));
    std::fs::remove_dir_all(&dir).unwrap();
}
