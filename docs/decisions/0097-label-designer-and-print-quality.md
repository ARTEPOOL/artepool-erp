# 0097 — Label designer, print quality, and what comes next for labels

| | |
|---|---|
| **Status** | Accepted (2026-10-20) |
| **Date** | 2026-10-20 |
| **Decided by** | Owner |
| **Related** | [0096](0096-barcode-labels-2-inch-printer.md) (extended), [0020](0020-print-template-designer.md) / [0064](0064-print-designer-and-locked-fields.md) (same versioned templates) |

## Decision

**Label designer** (Settings → Print designer → Barcode label, owner only, versioned like the other templates):
- **Elements**, each with show/hide, order, size (small / medium / large), bold and alignment (start / centre / end): Arabic name, English name, item code, barcode, digits under the bars, price, "incl. VAT", **sale pack** (the item's pack text, e.g. "كيس 25 كجم" / "25 kg bag", else its unit name, e.g. "Piece"), shop name, a free text line, **expiry date** and **batch number** (typed when printing), **print date** (small).
- **Barcode:** height, digits under the bars on/off, type (automatic, or always Code 128). A **minimum the design cannot go below**: bars at least 5 mm high, modules of at least 2 printer dots at 203 dpi (0.25 mm), full quiet zones (10 modules for Code 128, 11/7 for EAN-13).
- **Price:** in the label's language or both; "incl. VAT" always / when the item's price includes VAT / never. Margins and an optional border.
- **One base design for all sizes**, plus an **optional override per size** (for example hide the English name on 40 × 30). A size without an override uses the base design, fitted automatically.
- **Live preview with a real item at every active size**; a size the design does not fit says so ("won't fit in 40 × 30") instead of printing a broken label. **Print test label** and **Reset to the default design** inside the designer.

**Print quality** (the labels must be crisp):
- The label is pure 1-bit black and white at the printer's own dots: text drawn and then cut at a threshold (never dithered), nothing grey, no scaling. Tested: the image the printer gets has only black (0) and white (255).
- Text tuned for 203 dpi thermal: readable minimum sizes, a slightly bolder Arabic.
- The Windows driver is asked for the printer's own resolution and no smoothing, so it does not rescale the image.
- Label printer settings get **Darkness** and **Speed** (TSPL DENSITY 0–15 and SPEED), applied in RAW mode; in driver mode the screen shows what to set in the Windows printing preferences (Direct thermal, Gap media, darkness, speed).
- A **print quality test label**: fine lines of 1–3 dots, a solid block, small and large Arabic and English text, barcodes at 2 and 3 dots per module.

**Next, in this order:**
1. **Batch label printing** for many items at once (e.g. after goods arrive, the quantity per item = the quantity received), together with a list of **items whose price changed since their last label**, printable in one go. Each label print is recorded (item, price printed, copies, who, PC).
2. **RAW TSPL** to the label printer (the shop's 4BARCODE 2B speaks TSPL), with the driver way kept as the fallback.
3. **Later:** in-store EAN-13 numbers starting with 2, after confirming with GS1 UAE.

## Why
The owner wants to decide what the label says and how it looks, without ever being able to make a label a scanner cannot read; the shop sells chemicals where expiry and batch matter; prices change and shelf labels must follow.

## Consequences
- Label designs are versions of the `barcode_label` print template (audited, never changed later); items get optional sale pack texts; the label printer settings get darkness and speed; label prints are recorded for the "price changed" list.
- The layout engine works from the design (ordered elements) and still refuses anything that overlaps or goes outside the printable width.
