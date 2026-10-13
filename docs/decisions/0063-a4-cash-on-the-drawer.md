# 0063 — A4 cash taken by the cashier goes into their drawer; INV on the shift report for information

| | |
|---|---|
| **Status** | Accepted (posting pending accountant review, [0018](0018-chart-of-accounts-and-posting-map.md)) |
| **Date** | 2026-10-13 |
| **Decided by** | Owner |
| **Refines** | [0047](0047-office-cash-account.md) |

## Decision
- When cash is received in the A4 sections (paying an invoice at issue, or in Receipts) **by a user who has their own drawer shift open on that PC**, the cash goes **into that drawer**: it belongs to the shift, counts in its expected cash, and posts to the drawers account (the POS cash method's account), not Cash in safe.
- The same applies to a cash refund paid out in the A4 sections from that PC: it comes out of the drawer.
- **Card** payments taken the same way also belong to the shift, so the shift's card total matches the card terminal's settlement slip. Card never counts in the expected cash.
- Everywhere else (an office PC, or nobody's shift open on this PC for this user), office cash still goes to Cash in safe (0047).
- The X and Z reports show a line **"A4 invoices, for information"**: the number and total of the INV- invoices the cashier issued during the shift. It is not part of the shift's sales figures or its expected cash.

## Why
- In the shop the cashier takes A4 invoice cash and puts it in the drawer. Posting it to the safe would make the drawer look over at the count.

## Consequences
- The money shows under "Received · Cash" on the shift report and is counted at the close like POS cash.
- Cheque payments are unchanged (they never belong to a shift).
