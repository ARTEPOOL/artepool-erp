//! The RAW sender: bytes reach the printer exactly as given; bad names and empty jobs are refused.
#![cfg(not(windows))]

use artepool_printer::{
    LabelJob, PrintError, ReceiptBitmap, list_printers, send_image, send_label, send_raw,
};

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

    // Through the driver: the image as drawn (here a PBM file); bad images are refused.
    let bits = [0b1000_0000u8, 0x00, 0xff, 0x01];
    let image = ReceiptBitmap {
        width_dots: 9,
        height: 2,
        bits: &bits,
    };
    send_image("TM-T20III", "POS-000003", &image).unwrap();
    let pbm = std::fs::read(dir.join("TM-T20III.pbm")).unwrap();
    assert_eq!(&pbm[..7], b"P4\n9 2\n");
    assert_eq!(&pbm[7..], &bits);
    let short = ReceiptBitmap {
        width_dots: 9,
        height: 3,
        bits: &bits,
    };
    assert_eq!(
        send_image("TM-T20III", "x", &short),
        Err(PrintError::InvalidJob)
    );

    // Labels: the image, its real size and the number of copies; impossible jobs are refused.
    let label_bits = vec![0u8; 50 * 240];
    let label = |copies: u32, dpi: u32, width_mm10: u32| LabelJob {
        bitmap: ReceiptBitmap {
            width_dots: 400,
            height: 240,
            bits: &label_bits,
        },
        dpi,
        width_mm10,
        height_mm10: 300,
        copies,
    };
    send_label("TM-T20III", "labels", &label(3, 203, 500)).unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("TM-T20III.label")).unwrap(),
        "dpi=203 width_mm10=500 height_mm10=300 copies=3\n"
    );
    assert_eq!(
        &std::fs::read(dir.join("TM-T20III.pbm")).unwrap()[..11],
        b"P4\n400 240\n"
    );
    for bad in [
        label(0, 203, 500),
        label(501, 203, 500),
        label(1, 600, 500),
        label(1, 203, 400),
    ] {
        assert_eq!(
            send_label("TM-T20III", "x", &bad),
            Err(PrintError::InvalidJob)
        );
    }
    std::fs::remove_dir_all(&dir).unwrap();
}
