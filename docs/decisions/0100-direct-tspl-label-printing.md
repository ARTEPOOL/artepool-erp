# 0100 — Direct (RAW TSPL) label printing, the Windows driver kept as the other way

| | |
|---|---|
| **Status** | Accepted (2026-10-20) |
| **Date** | 2026-10-20 |
| **Decided by** | Owner |
| **Related** | [0096](0096-barcode-labels-2-inch-printer.md), [0097](0097-label-designer-and-print-quality.md) (the step it named), [0099](0099-batch-labels-and-price-changed-list.md) |

## Decision

- Each PC's label printer has a **printing way**: **Windows driver** (as before, the default) or **Direct (TSPL)**. The shop's printer (4BARCODE 2B / LV-275) speaks TSPL.
- **Direct:** the label the app draws (1 bit per printer dot) is sent RAW to the printer as one TSPL job: `SIZE`, `GAP`, `DIRECTION`, `REFERENCE 0,0`, `DENSITY` (darkness), `SPEED`, `CLS`, one `BITMAP`, `PRINT 1,<copies>`. Nothing in between scales or smooths it.
  - The label sits in the middle of the print head: a label wider than the head (50 mm on 48 mm) is cut to the head, centred; a narrower one (40 mm) starts that far in. The offset found with the test label still moves it.
  - Two settings for this way, per PC: the **gap between labels** (default 2 mm, 0–10 mm) and **turn the print round** (if labels come out upside down).
- **The driver stays the other way.** A direct print that fails is **not** sent again through the driver by itself: the printer may have printed part of it already, and doubled labels would follow. The message says to try again or to switch the printing way back to "Windows driver" in Settings → Devices.
- The test label and the print quality test go the chosen way, so the owner checks the direct way with them before using it.

## Consequences

- No change in the Windows part of the app: the RAW sender already used for receipts sends the TSPL job.
- Migration 0042: the database accepts `gapMm` and `flip` in a PC's label printer settings, and refuses wrong values.
- Tests: the job's commands exactly; the placement under the head (50 mm and 40 mm); black dots stay black (TSPL prints a 0 bit); for any drawing the bitmap read back from the job is the drawing (203 and 300 dpi); the printing way chosen; a failed direct print not sent again through the driver; the settings saved and checked by the server and the database.
