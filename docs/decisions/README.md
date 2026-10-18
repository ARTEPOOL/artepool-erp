# Decision records

There is one short file per decision, numbered in order.

- **Never edit an accepted decision to change it.** Add a new decision that supersedes it, and update the status of the old one.
- **Keep `PRD.md` and `CLAUDE.md` in step** with every decision.

| # | Decision | Status |
|---|---|---|
| [0001](0001-tech-stack.md) | Tech stack | Accepted |
| [0002](0002-separate-private-repository.md) | Separate private repository | Accepted |
| [0003](0003-pos-oversell-with-approval.md) | POS out-of-stock: sell with supervisor approval | Accepted |
| [0004](0004-one-cashier-per-drawer-shift.md) | One cashier per drawer shift | Accepted |
| [0005](0005-cart-removals-logged-without-approval.md) | Cart removals: no approval, logged silently | Accepted |
| [0006](0006-one-recount-with-supervisor-approval.md) | Shift-close recount: once, with supervisor approval | Accepted |
| [0007](0007-no-code-signing-certificate-for-now.md) | No code-signing certificate for now | Accepted (revisit later) |
| [0008](0008-printing-pos-silent-a4-section.md) | Printing: silent POS receipts, separate A4 section | Accepted |
| [0009](0009-vat-per-line.md) | VAT calculated per line | Accepted |
| [0010](0010-invoice-format-by-vat-registration.md) | Invoice format follows VAT registration | Accepted |
| [0011](0011-document-numbering-series.md) | Document numbering series (POS- / INV- …) | Accepted (other prefixes approved as defaults) |
| [0012](0012-discounts-net-revenue-per-line.md) | Discounts: revenue net, stored per line | Accepted |
| [0013](0013-advance-and-progress-payments-vat.md) | Advance and progress payments: VAT on receipt | Accepted |
| [0014](0014-money-precision-and-rounding.md) | Money precision (fils + 4 decimals) and rounding | Accepted |
| [0015](0015-defective-returns-held-at-cost.md) | Defective returns held at cost | Accepted |
| [0016](0016-monthly-period-lock.md) | Monthly period lock; never delete | Accepted |
| [0017](0017-quarterly-vat-export-and-annual-archive.md) | Quarterly VAT export package and annual archive | Accepted (Phase 2) |
| [0018](0018-chart-of-accounts-and-posting-map.md) | Chart of accounts and posting map | **Pending accountant review** |
| [0019](0019-einvoicing-via-accredited-provider.md) | E-invoicing via accredited service provider | Approach accepted; **go-live date pending** |
| [0020](0020-print-template-designer.md) | Print template designer (versioned, locked tax fields) | Accepted |
| [0021](0021-cashier-pin-sign-in-on-pos-pcs.md) | Cashier PIN sign-in only on POS PCs | Accepted |
| [0022](0022-owner-2-step-recovery.md) | Owner 2-step code: recovery codes and server-only emergency reset | Accepted |
| [0023](0023-password-rules.md) | Password rules (10+ characters, common ones refused, no expiry) | Accepted |
| [0024](0024-device-enrollment-proves-the-server.md) | Device enrollment: 10-minute one-time code that also proves the server | Accepted |
| [0025](0025-first-owner-and-pc-from-server-commands.md) | First owner and first PC created by server commands | Accepted |
| [0026](0026-users-and-devices-never-deleted.md) | Users and devices never deleted: deactivate or revoke with a reason | Accepted |
| [0027](0027-trust-this-pc-for-the-2-step-code.md) | "Trust this PC" for the 2-step code (30 days, never on POS PCs) | Changed by 0077 |
| [0028](0028-forgot-password-with-phone-and-recovery-code.md) | Forgot password: recover it in the app with the phone code and one recovery code | Accepted |
| [0029](0029-owner-password-reset-on-the-server-pc.md) | Emergency owner password reset on the server PC (`pnpm owner:reset-password`) | Accepted |
| [0030](0030-company-details-owner-only.md) | Company details owner-only; the accountant keeps the audit log | Accepted |
| [0031](0031-excel-import-all-or-nothing.md) | Excel import: all or nothing, after a full check with a row-by-row report | Accepted |
| [0032](0032-one-sale-price-with-vat-flag-and-customer-types.md) | One sale price per item with a "price includes VAT" switch; VAT shown on every invoice; customer types; price levels ready for later | Accepted |
| [0033](0033-four-fixed-uae-vat-categories.md) | Four fixed UAE VAT categories; only the owner changes a rate | Accepted |
| [0034](0034-master-data-screen-placement.md) | Where the master-data screens go (Suppliers and Accounting in the side menu; Settings → Lists) | Accepted |
| [0035](0035-fiscal-year-and-provisional-chart.md) | Fiscal year January–December; chart of accounts provisional until the accountant approves | Accepted |
| [0036](0036-customers-start-as-cash.md) | New customers start as cash; credit is a permissioned, audited change | Accepted |
| [0037](0037-master-data-defaults.md) | Master-data rules: item codes, phones, TRNs, logo, never deleted | Accepted |
| [0038](0038-item-purchase-price-owner-only.md) | Item purchase price: without VAT, owner only, copied onto each sale | Accepted |
| [0039](0039-owner-reports-dashboard.md) | Owner reports dashboard: four figures, date range, net profit after expenses | Accepted |
| [0040](0040-stock-cost-visibility.md) | Stock cost and value: owner and accountant only | Accepted |
| [0041](0041-stock-adjustment-approval-threshold.md) | Adjustments above 500.00 AED need a supervisor's approval | Replaced by 0054 |
| [0042](0042-opening-stock-owner-only.md) | Opening stock: once at go-live, posted by the owner only | Accepted |
| [0043](0043-barcode-label-sizes.md) | Barcode labels: list of sizes, custom sizes, print dialog | Accepted |
| [0044](0044-blind-stock-counts.md) | Blind full counts; one warehouse in Phase 1 | Accepted |
| [0045](0045-sales-sections-in-the-side-menu.md) | Sales screens: Invoices (A4), Quotations and Receipts are separate sections | Accepted |
| [0046](0046-unpaid-invoice-for-cash-customers.md) | An unpaid invoice for a cash customer needs credit or a supervisor's approval | Accepted |
| [0047](0047-office-cash-account.md) | Cash received in the office goes to Cash in safe by default | Accepted |
| [0048](0048-cheques-paid-on-receipt.md) | A cheque counts as paid when received; a bounced cheque is reversed | Accepted |
| [0049](0049-quotation-validity-and-prices.md) | Quotations are valid 15 days by default; their prices are kept on conversion | Accepted |
| [0050](0050-print-designer-after-m4.md) | M4 prints with a default design; the print designer screen follows as M4b | Accepted |
| [0051](0051-customer-opening-balances-owner-only.md) | Customer opening balances: once at go-live, owner only | Accepted |
| [0052](0052-payment-allocation-oldest-first.md) | A payment without chosen invoices settles the oldest first; the rest is an advance | Accepted |
| [0054](0054-no-approval-for-stock-adjustments.md) | Stock adjustments need no supervisor's approval (the limit setting is empty) | Accepted |
| [0053](0053-new-item-quantity.md) | A new item's quantity on hand is entered with the item by the owner, accountant or storekeeper (as its opening stock) | Accepted |
| [0055](0055-thermal-printer-esc-pos.md) | Thermal receipts: standard 80 mm ESC/POS printers, drawer on the printer | Accepted |
| [0056](0056-blind-count-denominations.md) | Shift count: denominations down to 0.05 AED plus an "other amount" | Accepted |
| [0057](0057-cash-drop-alert.md) | Cash drop alert above AED 3,000 | Accepted |
| [0058](0058-shift-variance-acceptance.md) | Shift over/short: accepted by the owner or accountant; alert on repeated variances | Accepted |
| [0059](0059-pos-discounts-and-prices.md) | POS discounts and price changes: the same rules as A4 invoices | Accepted |
| [0060](0060-pos-returns.md) | POS returns: a credit note, refunded from the open shift | Accepted |
| [0061](0061-card-payments-no-card-data.md) | Card payments: amount and approval code only | Accepted |
| [0062](0062-pos-receipt-and-customer.md) | POS receipt in Arabic and English; cash customer by default | Accepted |
| [0063](0063-a4-cash-on-the-drawer.md) | A4 cash taken by the cashier goes into their drawer; A4 invoices in the shift's sales | Accepted |
| [0064](0064-print-designer-and-locked-fields.md) | The print designer (M4b) and the fields that can never be hidden | Accepted (locked fields pending accountant review) |
| [0065](0065-company-bank-accounts.md) | Company bank accounts, and which one prints | Accepted |
| [0066](0066-customer-po-number.md) | Customer PO number on A4 invoices and quotations | Accepted |
| [0067](0067-qr-code-deferred.md) | No QR code on printed documents until e-invoicing | Accepted |
| [0068](0068-fonts.md) | The app's fonts: GE SS TV for Arabic, Tw Cen MT for English | Accepted |
| [0069](0069-stuck-shifts.md) | Stuck shifts: close from another PC; the drawer moves with its PC; no revoking a PC with an open shift | Accepted |
| [0070](0070-receipt-printer-modes-and-layout.md) | Receipt printer: ESC/POS or any printer through its Windows driver; the new receipt look with a separator between items | Accepted |
| [0071](0071-a4-invoices-full-and-reprints-current-design.md) | A4 invoices are full tax invoices when the customer is registered or has an address on file (else simplified); reprints use today's design | Accepted (pending accountant review) |
| [0072](0072-cancel-or-edit-issued-invoice.md) | Cancel or edit an issued A4 invoice with the owner's approval: a full credit note, refund at once, a new draft for edits | Accepted |
| [0073](0073-approval-pin-for-password-users.md) | Supervisors who sign in with a password set their own approval PIN (account menu); it never signs anyone in | Replaced by 0074 |
| [0074](0074-approvals-with-the-phone-code.md) | Supervisor approvals with the one-time code from the approver's 2-step app; approval PINs removed | Accepted |
| [0075](0075-separate-receipt-logo.md) | The thermal receipt can have its own logo (Print designer → Thermal receipt); empty = the company logo; A4 keeps the company logo | Accepted |
| [0076](0076-centre-logo-letterhead.md) | Logo in the middle (A4, both languages): Arabic details on the right, English on the left | Accepted |
| [0077](0077-two-step-code-once-per-pc.md) | The 2-step code once per PC: the PC is remembered (ticked by default) until the password changes; never on POS PCs | Accepted |
| [0078](0078-owner-remembered-on-pos-pcs.md) | The owner (only) may be remembered on POS PCs too, until the password changes | Accepted |
| [0079](0079-screen-lock-optional.md) | The idle screen lock can be turned off per kind of PC (Settings → Devices); off on every PC at the owner's request | Accepted |
| [0080](0080-owner-sees-expected-cash.md) | The owner sees the expected cash on "My shift" (others count blind); drop alerts clear themselves once no longer true | Accepted |
| [0081](0081-owner-dashboard.md) | Owner dashboard: sales, VAT, profit with comparison; daily chart; splits; top items/customers; cash, receivables and stock now | Accepted (VAT/profit pending accountant) |
| [0082](0082-app-mode-by-device-kind-and-pos-kiosk.md) | One app; the device kind decides the mode; POS PCs start in app-level kiosk mode (no closing, watchdog restart, exits audited and alerted) | Proposed |
| [0083](0083-exiting-kiosk-mode-owner-only.md) | Leaving kiosk mode: owner only, 15 minutes; from the owner's Office PC with 2-step, or the owner's code on the lock screen | Proposed |
| [0084](0084-remote-access-through-private-vpn.md) | Remote access only through a private VPN (Tailscale/WireGuard); never an open port; outside the LAN always password + 2-step | Proposed |
| [0085](0085-server-on-the-pos-pc.md) | The server runs on the POS PC: services under their own accounts, restrictive permissions, standard cashier account, UPS reminder | Proposed |
| [0086](0086-backups-local-and-google-drive.md) | Backups: hourly local, daily age-encrypted to Google Drive (private key offline), weekly external drive, restore test | Proposed |
| [0087](0087-cashiers-and-drawers-growth.md) | One cashier now; two cashiers on one PC and a second POS PC later, without redesign | Proposed |
| [0088](0088-no-cloud-database-outbox-for-mobile.md) | No cloud database in Phase 1; an outbox for a read-only mobile dashboard in Phase 2 | Proposed |

## Template

```markdown
# NNNN — Title

| | |
|---|---|
| **Status** | Proposed / Accepted / Pending accountant review / Superseded by NNNN |
| **Date** | YYYY-MM-DD |
| **Decided by** | Owner / accountant |

## Decision
## Why
## How it works
## Consequences
```
