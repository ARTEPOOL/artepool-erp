# 0098 — Barcode quiet zones may use the label's side margin

| | |
|---|---|
| **Status** | Accepted (2026-10-20) |
| **Date** | 2026-10-20 |
| **Decided by** | Owner |
| **Related** | [0096](0096-barcode-labels-2-inch-printer.md), [0097](0097-label-designer-and-print-quality.md) (minimum barcode size, unchanged) |

## Context

On a 40 × 30 label, a 10-character item code such as `EQUIP-0001` or `CLEAN-0001` (no supplier barcode) was refused: Code 128 at the minimum module (2 dots at 203 dpi) with its two quiet zones of 10 modules needs 308 dots (38.5 mm), and the content area inside the 1 mm side margins is 304 dots (38 mm). The quiet zones only need blank paper, and the margin is blank paper.

## Decision

- The **bars** stay inside the content area (the label's printable width minus the side margins), as before.
- The **quiet zones** (blank) may reach into the side margin, but must stay **at least 0.5 mm inside the label's physical edge** (to absorb small sideways drift of the roll).
- With a **border** on the label, the quiet zones stay inside the border: the border line next to the bars would read as a bar.
- The **minimum readable barcode does not change**: modules of at least 2 printer dots at 203 dpi (0.25 mm), bars at least 5 mm high, full quiet zones (Code 128 10/10, EAN-13 11/7, UPC-A 9/9, EAN-8 7/7).
- A code that still does not fit is refused, never printed broken; the message suggests 50 × 30.

## Consequences

- 40 × 30 now takes Code 128 item codes of up to 10 characters in the usual "LETTERS-0000" form (`CHEM-0013`, `EQUIP-0001`, `CLEAN-0001`); longer ones (e.g. `FILTER-00012`) go on 50 × 30.
- Some labels on wider sizes may get slightly wider bars (up to 3 dots per module), which reads more easily.
- Tests: every layout keeps its quiet zones 0.5 mm from the edge (or inside the border); the 40 × 30 labels for `EQUIP-0001` and `CLEAN-0001` at 203 dpi are read back by a barcode reader, in unit tests and from the real drawn label in the browser.
