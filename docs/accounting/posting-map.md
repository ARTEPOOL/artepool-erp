# Posting map (one page, for the accountant)

**Status: pending accountant review** ([decision 0018](../decisions/0018-chart-of-accounts-and-posting-map.md)). Account codes refer to the [provisional chart of accounts](chart-of-accounts.md).

**How to read this page:** when the event in the first column happens, the system automatically records the debit and credit shown, in the same instant as the operation itself. "Line of business" means pool supplies, construction, maintenance or cleaning. Revenue is always **net of discount**, with no separate discount account. VAT is calculated per line.

| # | When this happens | Debit | Credit |
|---|---|---|---|
| 1 | **Sale invoice issued** (POS `POS-` or A4 `INV-`) | Customer receivable 1210 (total) | Revenue 41xx–44xx by line of business (net); VAT payable 2130 (VAT) |
| 2 | … for stock items on that sale | Cost of sales 51xx–54xx by line of business (average cost) | Inventory – sellable 1310 |
| 3 | **Customer pays** an issued invoice | Payment-method account: cash 1110 / card 1150 / bank 1140 / cheque 1160 | Customer receivable 1210 |
| 4 | **Advance or progress payment received** (no issued invoice covers it): its own tax invoice `INV-` | Customer receivable 1210 (amount received) | Customer advances 2120 (net); VAT payable 2130 (VAT) |
| 5 | … and the money itself | Payment-method account | Customer receivable 1210 |
| 6 | **Final invoice** that deducts earlier payments | Customer receivable 1210 (balance due); Customer advances 2120 (net deducted) | Revenue 41xx–44xx (full net); VAT payable 2130 (only the VAT not yet charged) |
| 7 | **Credit note** (return or price correction) | Revenue 41xx–44xx (net); VAT payable 2130 (VAT) | Customer receivable 1210 |
| 8 | … goods returned to stock | Inventory – sellable 1310, or Inventory – defective 1320 if broken (at the cost they left at) | Cost of sales 51xx–54xx |
| 9 | **Credit note on an advance** (work cancelled) | Customer advances 2120 (net); VAT payable 2130 | Customer receivable 1210 |
| 10 | **Refund paid** to the customer | Customer receivable 1210 | Payment-method account |
| 11 | **Payment reversed** (e.g. bounced cheque) | Customer receivable 1210 | Cheques in hand 1160 (or the original method's account) |
| 12 | **Oversell approved** at the POS (missing stock added) | Inventory – sellable 1310 | Inventory adjustments 5600 |
| 13 | **Stock count / adjustment**: more found / less found | More found: Inventory 1310 · Less found: Inventory adjustments 5600 | More found: Inventory adjustments 5600 · Less found: Inventory 1310 |
| 14 | **Goods moved to defective** | Inventory – defective 1320 | Inventory – sellable 1310 (same value) |
| 15 | **Defective goods written off** | Defective stock write-offs 5700 | Inventory – defective 1320 |
| 16 | **Paid-out** from the drawer (e.g. small purchase) | The account linked to the reason (default: petty cash expenses 6900) | Cash on hand – POS drawers 1110 |
| 17 | **Paid-in** to the drawer | Cash on hand – POS drawers 1110 | The account linked to the reason |
| 18 | **Cash drop** to the safe / **float top-up** from the safe | Drop: Cash in safe 1120 · Top-up: Cash drawers 1110 | Drop: Cash drawers 1110 · Top-up: Cash in safe 1120 |
| 19 | **Shift closed short** (over = the reverse) | Cash over / short 6910 | Cash on hand – POS drawers 1110 |
| 20 | **Opening customer balances** (go-live) | Customer receivable 1210 | Opening balance equity 3900 |
| 21 | **Opening stock** (go-live) | Inventory – sellable 1310 | Opening balance equity 3900 |

**Always true:**
- Every entry balances (total debits = total credits). The database refuses anything else.
- A document can be posted only once.
- Nothing can be posted into a closed or locked month.
- Corrections are made with new documents (credit notes, reversals), never by editing.

**Please confirm or correct:**
- **Rows 4–6 and 9:** customer advances and VAT on payments received.
- **Rows 12–13:** one adjustments account for gains and losses.
- **Rows 14–15:** defective goods held at cost until written off.
- **Row 19:** cash over/short.
- **Rows 20–21:** opening balances through account 3900.
