//! Silent receipt printing (decisions 0008, 0055, 0070). The screens draw the receipt as an image.
//! For an ESC/POS thermal printer they turn it into ESC/POS bytes, and this crate sends those bytes
//! unchanged, RAW through the Windows spooler. For any other printer (an A4 printer, or a thermal
//! printer whose driver does not pass ESC/POS through) the image goes through the printer's own
//! driver instead. Either way no print dialog opens and Arabic prints correctly. The cash drawer, wired to the printer (RJ11), opens with
//! the drawer-kick bytes inside the same job.
//!
//! Barcode labels (decision 0096) are images too: the driver is given the label's exact paper size
//! and each label is one page.
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

/// A receipt drawn by the screens: 1 bit per dot, rows of `width_bytes` bytes, top row first,
/// most significant bit = leftmost dot, 1 = black. Drawn at 203 dpi (thermal printer dots).
pub struct ReceiptBitmap<'a> {
    pub width_dots: u32,
    pub height: u32,
    pub bits: &'a [u8],
}

/// The dots per inch the screens draw the receipt at (a thermal printer head).
pub const RECEIPT_DPI: i32 = 203;

impl ReceiptBitmap<'_> {
    pub fn width_bytes(&self) -> usize {
        (self.width_dots as usize).div_ceil(8)
    }

    fn check(&self) -> Result<(), PrintError> {
        if self.width_dots == 0
            || self.width_dots > 2048
            || self.height == 0
            || self.height > 40_000
            || self.bits.len() != self.width_bytes() * self.height as usize
        {
            return Err(PrintError::InvalidJob);
        }
        Ok(())
    }
}

/// Prints the receipt image through the printer's own Windows driver, silently (no dialog):
/// for any printer, thermal or A4, that does not take ESC/POS bytes. The image keeps its real
/// size (80 or 58 mm wide), centred across the page; a long receipt continues on the next page.
pub fn send_image(
    printer: &str,
    document_name: &str,
    image: &ReceiptBitmap<'_>,
) -> Result<(), PrintError> {
    check_name(printer)?;
    image.check()?;
    imp::send_image(printer, document_name, image)
}

/// Most labels printed in one go.
pub const MAX_LABEL_COPIES: u32 = 500;

/// A barcode label drawn by the screens (decision 0096) at the label printer's own dots, and the
/// label's real size: the driver is given that paper size, so nothing is scaled or moved by it.
pub struct LabelJob<'a> {
    pub bitmap: ReceiptBitmap<'a>,
    /// The label printer's dots per inch (203 or 300): the bitmap is drawn at this density.
    pub dpi: u32,
    /// The label's width and height in tenths of a millimetre (500 × 300 = 50 × 30 mm).
    pub width_mm10: u32,
    pub height_mm10: u32,
    /// How many labels: one page each.
    pub copies: u32,
}

impl LabelJob<'_> {
    fn check(&self) -> Result<(), PrintError> {
        self.bitmap.check()?;
        let dots = |mm10: u32| (mm10 as f64 * self.dpi as f64 / 254.0).round() as i64;
        let fits = |dots_drawn: u32, mm10: u32| (dots_drawn as i64 - dots(mm10)).abs() <= 2;
        if !matches!(self.dpi, 203 | 300)
            || !(100..=1200).contains(&self.width_mm10)
            || !(100..=3000).contains(&self.height_mm10)
            || !(1..=MAX_LABEL_COPIES).contains(&self.copies)
            || !fits(self.bitmap.width_dots, self.width_mm10)
            || !fits(self.bitmap.height, self.height_mm10)
        {
            return Err(PrintError::InvalidJob);
        }
        Ok(())
    }
}

/// Prints labels through the printer's own Windows driver, silently: the driver gets the label's
/// exact paper size, and each label is one page with the image at its real size, centred on the
/// paper (the X/Y offset is already drawn into the image).
pub fn send_label(
    printer: &str,
    document_name: &str,
    job: &LabelJob<'_>,
) -> Result<(), PrintError> {
    check_name(printer)?;
    job.check()?;
    imp::send_label(printer, document_name, job)
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
        fn DocumentPropertiesW(
            window: isize,
            handle: isize,
            device_name: *const u16,
            output: *mut u8,
            input: *const u8,
            mode: u32,
        ) -> i32;
    }

    #[repr(C)]
    struct DocInfoW {
        size: i32,
        doc_name: *const u16,
        output: *const u16,
        datatype: *const u16,
        flags: u32,
    }

    #[repr(C)]
    struct BitmapInfo {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_ppm: i32,
        y_ppm: i32,
        clr_used: u32,
        clr_important: u32,
        /// Index 0 = white paper, index 1 = black.
        colors: [[u8; 4]; 2],
    }

    const PHYSICALWIDTH: i32 = 110;
    const PHYSICALOFFSETX: i32 = 112;
    const PHYSICALOFFSETY: i32 = 113;
    const DM_OUT_BUFFER: u32 = 2;
    const DM_IN_BUFFER: u32 = 8;
    // DEVMODEW: dmFields at byte 72, then dmOrientation, dmPaperSize, dmPaperLength, dmPaperWidth.
    const DM_FIELDS_AT: usize = 72;
    const DM_SCALE_AT: usize = 84;
    const DM_PRINTQUALITY_AT: usize = 90;
    const DM_YRESOLUTION_AT: usize = 96;
    const DM_SCALE: u32 = 0x10;
    const DM_PRINTQUALITY: u32 = 0x400;
    const DM_YRESOLUTION: u32 = 0x2000;
    const COLORONCOLOR: i32 = 3;
    const DM_ORIENTATION_AT: usize = 76;
    const DM_PAPERSIZE_AT: usize = 78;
    const DM_PAPERLENGTH_AT: usize = 80;
    const DM_PAPERWIDTH_AT: usize = 82;
    const DM_ORIENTATION: u32 = 0x1;
    const DM_PAPERSIZE: u32 = 0x2;
    const DM_PAPERLENGTH: u32 = 0x4;
    const DM_PAPERWIDTH: u32 = 0x8;
    const DMORIENT_PORTRAIT: i16 = 1;
    const DMPAPER_USER: i16 = 256;
    const HORZRES: i32 = 8;
    const VERTRES: i32 = 10;
    const LOGPIXELSX: i32 = 88;
    const LOGPIXELSY: i32 = 90;
    const DIB_RGB_COLORS: u32 = 0;
    const SRCCOPY: u32 = 0x00CC_0020;

    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn CreateDCW(
            driver: *const u16,
            device: *const u16,
            output: *const u16,
            init: *const c_void,
        ) -> isize;
        fn DeleteDC(hdc: isize) -> i32;
        fn StartDocW(hdc: isize, info: *const DocInfoW) -> i32;
        fn EndDoc(hdc: isize) -> i32;
        fn AbortDoc(hdc: isize) -> i32;
        fn StartPage(hdc: isize) -> i32;
        fn EndPage(hdc: isize) -> i32;
        fn GetDeviceCaps(hdc: isize, index: i32) -> i32;
        fn SetStretchBltMode(hdc: isize, mode: i32) -> i32;
        fn StretchDIBits(
            hdc: isize,
            x_dest: i32,
            y_dest: i32,
            dest_width: i32,
            dest_height: i32,
            x_src: i32,
            y_src: i32,
            src_width: i32,
            src_height: i32,
            bits: *const c_void,
            info: *const BitmapInfo,
            usage: u32,
            rop: u32,
        ) -> i32;
    }

    /// The image through the printer driver (GDI): real size, centred, split across pages.
    pub fn send_image(
        printer: &str,
        document_name: &str,
        image: &super::ReceiptBitmap<'_>,
    ) -> Result<(), PrintError> {
        let name = wide(printer);
        let doc = wide(document_name);
        let (dib, dib_row) = to_dib(image);
        // SAFETY: valid NUL-terminated wide strings; the device context is deleted on every path.
        unsafe {
            let hdc = CreateDCW(
                std::ptr::null(),
                name.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
            );
            if hdc == 0 {
                return Err(last_error());
            }
            let result = (|| {
                let info = DocInfoW {
                    size: std::mem::size_of::<DocInfoW>() as i32,
                    doc_name: doc.as_ptr(),
                    output: std::ptr::null(),
                    datatype: std::ptr::null(),
                    flags: 0,
                };
                if StartDocW(hdc, &info) <= 0 {
                    return Err(last_error());
                }
                let page_w = GetDeviceCaps(hdc, HORZRES).max(1);
                let page_h = GetDeviceCaps(hdc, VERTRES).max(1);
                let dpi_x = GetDeviceCaps(hdc, LOGPIXELSX).max(1);
                let dpi_y = GetDeviceCaps(hdc, LOGPIXELSY).max(1);
                // Real size: receipt dots at 203 dpi → device pixels, never wider than the page.
                let mut scale_x = dpi_x as f64 / super::RECEIPT_DPI as f64;
                if image.width_dots as f64 * scale_x > page_w as f64 {
                    scale_x = page_w as f64 / image.width_dots as f64;
                }
                let scale_y = scale_x * dpi_y as f64 / dpi_x as f64;
                let dest_w = (image.width_dots as f64 * scale_x).round() as i32;
                let x = (page_w - dest_w) / 2;
                let rows_per_page = ((page_h as f64 / scale_y).floor() as u32).max(1);
                let mut row = 0u32;
                while row < image.height {
                    let rows = rows_per_page.min(image.height - row);
                    if StartPage(hdc) <= 0 {
                        AbortDoc(hdc);
                        return Err(last_error());
                    }
                    let header = mono_header(image.width_dots, rows);
                    let chunk = dib[row as usize * dib_row..].as_ptr();
                    let drawn = StretchDIBits(
                        hdc,
                        x,
                        0,
                        dest_w,
                        (rows as f64 * scale_y).round() as i32,
                        0,
                        0,
                        image.width_dots as i32,
                        rows as i32,
                        chunk.cast(),
                        &header,
                        DIB_RGB_COLORS,
                        SRCCOPY,
                    );
                    if drawn == 0 {
                        AbortDoc(hdc);
                        return Err(last_error());
                    }
                    if EndPage(hdc) <= 0 {
                        AbortDoc(hdc);
                        return Err(last_error());
                    }
                    row += rows;
                }
                if EndDoc(hdc) <= 0 {
                    return Err(last_error());
                }
                Ok(())
            })();
            DeleteDC(hdc);
            result
        }
    }

    /// The bitmap as a DIB: each row padded to a whole number of 32-bit words.
    fn to_dib(image: &super::ReceiptBitmap<'_>) -> (Vec<u8>, usize) {
        let src_row = image.width_bytes();
        let dib_row = src_row.div_ceil(4) * 4;
        let mut dib = vec![0u8; dib_row * image.height as usize];
        for (y, row) in image.bits.chunks(src_row).enumerate() {
            dib[y * dib_row..y * dib_row + src_row].copy_from_slice(row);
        }
        (dib, dib_row)
    }

    fn mono_header(width: u32, rows: u32) -> BitmapInfo {
        BitmapInfo {
            size: 40,
            width: width as i32,
            // Negative: the rows run top to bottom.
            height: -(rows as i32),
            planes: 1,
            bit_count: 1,
            compression: 0,
            size_image: 0,
            x_ppm: 0,
            y_ppm: 0,
            clr_used: 2,
            clr_important: 2,
            colors: [[255, 255, 255, 0], [0, 0, 0, 0]],
        }
    }

    /// The printer's settings with the label's paper size (user-defined, portrait), or an error.
    fn label_devmode(name: &[u16], job: &super::LabelJob<'_>) -> Result<Vec<u64>, PrintError> {
        let mut handle: isize = 0;
        // SAFETY: valid NUL-terminated name; the buffer is as large as the driver asked for and
        // 8-byte aligned; the handle is closed on every path.
        unsafe {
            if OpenPrinterW(name.as_ptr(), &mut handle, std::ptr::null()) == 0 {
                return Err(last_error());
            }
            let result = (|| {
                let size = DocumentPropertiesW(
                    0,
                    handle,
                    name.as_ptr(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    0,
                );
                if size <= 0 {
                    return Err(last_error());
                }
                let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
                let dm = buffer.as_mut_ptr().cast::<u8>();
                if DocumentPropertiesW(
                    0,
                    handle,
                    name.as_ptr(),
                    dm,
                    std::ptr::null(),
                    DM_OUT_BUFFER,
                ) < 0
                {
                    return Err(last_error());
                }
                let fields = dm.add(DM_FIELDS_AT).cast::<u32>();
                // The label's paper, at the printer's own resolution and 100 %: the driver then has
                // nothing to scale, and the 1-bit image prints dot for dot.
                fields.write_unaligned(
                    fields.read_unaligned()
                        | DM_ORIENTATION
                        | DM_PAPERSIZE
                        | DM_PAPERLENGTH
                        | DM_PAPERWIDTH
                        | DM_SCALE
                        | DM_PRINTQUALITY
                        | DM_YRESOLUTION,
                );
                dm.add(DM_SCALE_AT).cast::<i16>().write_unaligned(100);
                dm.add(DM_PRINTQUALITY_AT)
                    .cast::<i16>()
                    .write_unaligned(job.dpi as i16);
                dm.add(DM_YRESOLUTION_AT)
                    .cast::<i16>()
                    .write_unaligned(job.dpi as i16);
                dm.add(DM_ORIENTATION_AT)
                    .cast::<i16>()
                    .write_unaligned(DMORIENT_PORTRAIT);
                dm.add(DM_PAPERSIZE_AT)
                    .cast::<i16>()
                    .write_unaligned(DMPAPER_USER);
                dm.add(DM_PAPERLENGTH_AT)
                    .cast::<i16>()
                    .write_unaligned(job.height_mm10 as i16);
                dm.add(DM_PAPERWIDTH_AT)
                    .cast::<i16>()
                    .write_unaligned(job.width_mm10 as i16);
                if DocumentPropertiesW(
                    0,
                    handle,
                    name.as_ptr(),
                    dm,
                    dm,
                    DM_IN_BUFFER | DM_OUT_BUFFER,
                ) < 0
                {
                    return Err(last_error());
                }
                Ok(buffer)
            })();
            ClosePrinter(handle);
            result
        }
    }

    /// Labels through the driver (GDI): the label's paper size, one page per label, the image at
    /// its real size, centred on the physical page.
    pub fn send_label(
        printer: &str,
        document_name: &str,
        job: &super::LabelJob<'_>,
    ) -> Result<(), PrintError> {
        let name = wide(printer);
        let doc = wide(document_name);
        let devmode = label_devmode(&name, job)?;
        let image = &job.bitmap;
        let (dib, _) = to_dib(image);
        let header = mono_header(image.width_dots, image.height);
        // SAFETY: valid NUL-terminated wide strings and settings buffer; the device context is
        // deleted on every path.
        unsafe {
            let hdc = CreateDCW(
                std::ptr::null(),
                name.as_ptr(),
                std::ptr::null(),
                devmode.as_ptr().cast(),
            );
            if hdc == 0 {
                return Err(last_error());
            }
            let result = (|| {
                let info = DocInfoW {
                    size: std::mem::size_of::<DocInfoW>() as i32,
                    doc_name: doc.as_ptr(),
                    output: std::ptr::null(),
                    datatype: std::ptr::null(),
                    flags: 0,
                };
                if StartDocW(hdc, &info) <= 0 {
                    return Err(last_error());
                }
                // Copy dots as they are (no smoothing into grey) if the driver must still scale.
                SetStretchBltMode(hdc, COLORONCOLOR);
                let dpi_x = GetDeviceCaps(hdc, LOGPIXELSX).max(1) as f64;
                let dpi_y = GetDeviceCaps(hdc, LOGPIXELSY).max(1) as f64;
                let dest_w = (image.width_dots as f64 * dpi_x / job.dpi as f64).round() as i32;
                let dest_h = (image.height as f64 * dpi_y / job.dpi as f64).round() as i32;
                // Device coordinates start at the printable area: centre on the physical page.
                let x = (GetDeviceCaps(hdc, PHYSICALWIDTH) - dest_w) / 2
                    - GetDeviceCaps(hdc, PHYSICALOFFSETX);
                let y = -GetDeviceCaps(hdc, PHYSICALOFFSETY);
                for _ in 0..job.copies {
                    if StartPage(hdc) <= 0 {
                        AbortDoc(hdc);
                        return Err(last_error());
                    }
                    let drawn = StretchDIBits(
                        hdc,
                        x,
                        y,
                        dest_w,
                        dest_h,
                        0,
                        0,
                        image.width_dots as i32,
                        image.height as i32,
                        dib.as_ptr().cast(),
                        &header,
                        DIB_RGB_COLORS,
                        SRCCOPY,
                    );
                    if drawn == 0 || EndPage(hdc) <= 0 {
                        AbortDoc(hdc);
                        return Err(last_error());
                    }
                }
                if EndDoc(hdc) <= 0 {
                    return Err(last_error());
                }
                Ok(())
            })();
            DeleteDC(hdc);
            result
        }
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
            EnumPrintersW(
                flags,
                std::ptr::null(),
                4,
                std::ptr::null_mut(),
                0,
                &mut needed,
                &mut returned,
            );
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
                    let ok = WritePrinter(
                        handle,
                        bytes.as_ptr().cast(),
                        bytes.len() as u32,
                        &mut written,
                    );
                    if ok == 0 {
                        page = Err(last_error());
                    } else if written as usize != bytes.len() {
                        page = Err(PrintError::Unavailable(
                            "the printer took only part of the job".into(),
                        ));
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
        let Some(dir) = file_printer_dir() else {
            return Ok(Vec::new());
        };
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .map_err(|e| PrintError::Unavailable(e.to_string()))?
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter_map(|n| n.strip_suffix(".bin").map(str::to_owned))
            .collect();
        names.sort();
        Ok(names)
    }

    /// The image as a PBM file (`<name>.pbm`, rewritten per job) next to the printer's file.
    pub fn send_image(
        printer: &str,
        _document_name: &str,
        image: &super::ReceiptBitmap<'_>,
    ) -> Result<(), PrintError> {
        let dir = file_printer_dir()
            .ok_or_else(|| PrintError::Unavailable("no printer folder".into()))?;
        if !dir.join(format!("{printer}.bin")).exists() {
            return Err(PrintError::Unavailable(format!(
                "no printer named {printer}"
            )));
        }
        let mut out = format!("P4\n{} {}\n", image.width_dots, image.height).into_bytes();
        out.extend_from_slice(image.bits);
        std::fs::write(dir.join(format!("{printer}.pbm")), out)
            .map_err(|e| PrintError::Unavailable(e.to_string()))
    }

    /// Labels: the image as `<name>.pbm` and the job as `<name>.label` (dpi, size, copies).
    pub fn send_label(
        printer: &str,
        document_name: &str,
        job: &super::LabelJob<'_>,
    ) -> Result<(), PrintError> {
        send_image(printer, document_name, &job.bitmap)?;
        let dir = file_printer_dir()
            .ok_or_else(|| PrintError::Unavailable("no printer folder".into()))?;
        let meta = format!(
            "dpi={} width_mm10={} height_mm10={} copies={}\n",
            job.dpi, job.width_mm10, job.height_mm10, job.copies
        );
        std::fs::write(dir.join(format!("{printer}.label")), meta)
            .map_err(|e| PrintError::Unavailable(e.to_string()))
    }

    pub fn send(printer: &str, _document_name: &str, bytes: &[u8]) -> Result<(), PrintError> {
        let dir = file_printer_dir()
            .ok_or_else(|| PrintError::Unavailable("no printer folder".into()))?;
        let path = dir.join(format!("{printer}.bin"));
        if !path.exists() {
            return Err(PrintError::Unavailable(format!(
                "no printer named {printer}"
            )));
        }
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .map_err(|e| PrintError::Unavailable(e.to_string()))?;
        file.write_all(bytes)
            .map_err(|e| PrintError::Unavailable(e.to_string()))
    }
}
