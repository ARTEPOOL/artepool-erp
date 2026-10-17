# 0070 — Receipt printer: two ways to print, and the new receipt look

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-17 |
| **Decided by** | Owner |
| **Refines** | [0008](0008-printing-pos-silent-a4-section.md), [0055](0055-thermal-printer-esc-pos.md) |

## Problem
A receipt sent to a printer that does not understand ESC/POS printed 5–6 pages with no data. This happens with an A4 printer, or with a receipt printer whose Windows driver does not pass ESC/POS through. The receipt should also look like the owner's sample, with a separator between items.

## Decision
- **Settings → Devices → Receipt printer** chooses how this PC's printer prints (kept on the PC):
  - **Thermal receipt printer (ESC/POS)**, the default: sent RAW as before; it cuts the paper and opens the drawer wired to the printer.
  - **Any printer (Windows driver)**: the same receipt image goes through the printer's own driver, silently, at its real width (80 or 58 mm), centred on the page. A long receipt continues on the next page. **The drawer does not open this way**, because ESC/POS bytes would print as rubbish on such a printer.
- **The new look**, for every receipt:
  - the seller centred at the top: logo, name, address, phone and e-mail, TRN;
  - the title; the number and the date on one line; the customer, cashier and PC;
  - an **Item / Amount** table, with a **dotted separator between items** and "qty × price" under each name;
  - net and VAT, a large **total**, and a framed **Paid** box when the payments cover the total;
  - the payments, the change, and the thank-you line.
- The tax content is unchanged: the locked fields (0064) still always print.
- Numbers, codes, phones and dates keep reading left to right inside Arabic.
- On narrow paper, a value that does not fit goes under its label.

## Consequences
- A shop can print receipts on any printer it has while waiting for a thermal one.
- The cash drawer needs the ESC/POS mode.
