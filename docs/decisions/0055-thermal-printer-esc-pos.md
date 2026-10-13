# 0055 — Thermal receipts: standard 80 mm ESC/POS printers, drawer on the printer

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-13 |
| **Decided by** | Owner |

## Decision
- The POS prints to **standard 80 mm ESC/POS printers** (Epson TM-T20III / TM-T82 and compatibles).
- The **cash drawer is connected to the printer** (RJ11 kick port) and is opened by the printer's kick command.
- The receipt is drawn in the app as an image and sent as ESC/POS raster, RAW and silent (0008), so Arabic shaping never depends on the printer's fonts.
- There is no printer yet: a **step-by-step manual hardware test checklist** is provided in `docs/runbooks/pos-hardware-test.md`.

## Why
- These printers are the common standard in the UAE; raster printing works the same on all of them.

## Consequences
- The printer is chosen per POS PC (Settings → Devices). Models with drawer status reporting can show a "drawer left open" alert later.
