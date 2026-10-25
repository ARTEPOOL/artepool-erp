# 0096 — Barcode labels for the 2-inch label printer: drawn in millimetres, printed silently

| | |
|---|---|
| **Status** | Accepted (2026-10-20) |
| **Date** | 2026-10-20 |
| **Decided by** | Owner |
| **Related** | [0043](0043-barcode-label-sizes.md) (updated), [0070](0070-receipt-printer-modes-and-layout.md) (same two printing ways) |

## Problem (seen on the shop's printer)
Labels printed through the Windows print dialog came out shifted to the left, the Arabic name ran into the barcode and was cut, "120.00 درهم" came out in the wrong order, and other sizes were worse. Causes found in the code: the page size and position were left to the printer driver (no centring, no offset), every part of the label was a percentage of its height (nothing reserved), the barcode was stretched to the label's width (bars of 0.9–3.8 printer dots instead of whole dots) and always Code 128 set B, and the price was one string whose direction the browser guessed.

## Decision
**The printer.** LENVII LV-275: 2-inch (58 mm) direct thermal label printer, 203 dpi, USB, label gap 2.25 mm. Its self-test lists TSPL settings (SIZE, GAP, REFERENCE, DIRECTION, SHIFT, OFFSET) and an ESC/POS receipt mode. Printable width 48 mm (384 dots) unless its own page says otherwise.

**Sizes.**
- **50 × 30 mm is the default**, then **50 × 25** and **40 × 30** (38 × 25 stays as a fourth).
- **25 × 15, 30 × 20, 58 × 40 and 100 × 50 are deactivated** with a reason (never deleted): too small for a readable barcode and name, or wider than the roll.
- **No size wider than the roll** can be added or switched back on: setting `labels.max_width_mm` (50 mm), enforced by the database.
- A label may be 50 mm wide, but **its content never goes beyond the printer's printable width** (48 mm by default, a per-PC setting), centred on the label.

**Layout (fixed zones in millimetres, drawn at the printer's own dots).**
- **Arabic name always**: at most 2 lines; the letters get smaller down to a readable minimum, then "…" ends the second line. Option on the label screen: **"Add English name if it fits"** (one line, only when there is room).
- **Barcode** with bars of whole printer dots and full quiet zones: **EAN-13 / EAN-8 / UPC-A** when the item's barcode is one (check digit correct), otherwise **Code 128** of the item code or barcode (set C for runs of digits, so it is shorter).
- **Human-readable code** under the bars.
- **Price**: "120.00 درهم" on Arabic labels, "AED 120.00" on English labels; the number is always its own left-to-right run.
- **"شامل الضريبة / incl. VAT"** under the price when the item's price includes VAT.
- A size that cannot hold all of this is refused on the screen ("too small"), never printed overlapped.

**Printing.**
- The app draws the label itself as an image at the printer's dots (as for thermal receipts, decision 0070); the same image is the preview and what is printed.
- **Silent printing** from the item screen and the labels screen, with a quantity: the image goes through the printer's own Windows driver at the label's exact size (one page per label). The Windows print dialog stays only as a fallback (and for A4 label sheets).
- **Phase B (next):** RAW **TSPL** to the label printer (size, gap, offset, darkness, speed, one image per label), the language being a per-printer setting (TSPL first, ZPL later); the driver way stays as the fallback.

**Label printer of each PC** (Settings → Devices, owner): printer, dpi (203/300), printable width, X/Y offset in mm, and for RAW later darkness and speed. **Kept per PC on the server** (`auth.devices.printer_config`, audited), so it survives a reinstall; whoever prints labels on that PC uses it. **"Print test label"**: border, centre cross, 5 mm ruler and a test barcode, to set the offset.

**Later, separately:** in-store EAN-13 numbers starting with 2 (GS1 restricted circulation numbers) for items without a supplier barcode, after confirming the range with GS1 UAE.

## Why
- The driver's paper settings and scaling decide where an HTML page lands; drawing the exact image ourselves and sending it at its real size (or RAW) removes that guesswork.
- A scanner needs bars of whole dots and blank quiet zones; supplier barcodes are EAN-13 and should stay EAN-13.
- The printer's own fonts have no Arabic; an image keeps Arabic shaped correctly.

## Consequences
- Migration 0037: sizes and the `labels.max_width_mm` setting; the label sizes list returns the roll width.
- Tests: no overlap for every size and very long names (property tests), barcodes decoded from the drawn image at 203 and 300 dpi, price order checked in a real browser in both languages.
