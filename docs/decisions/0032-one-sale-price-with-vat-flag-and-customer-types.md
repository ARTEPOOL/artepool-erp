# 0032 — One sale price per item with a "price includes VAT" switch; customer types

| | |
|---|---|
| **Status** | Accepted. Replaces the two price lists (`RETAIL` / `CONTRACTOR`) of the M2 plan and the schema draft. |
| **Date** | 2026-10-08 |
| **Decided by** | Owner |

## Decision
- **VAT applies to every customer:** individuals, contractors and companies, with no exceptions.
  - The type of customer never removes or lowers VAT.
  - The rate comes only from the item's VAT category (standard 5%, decision [0033](0033-four-fixed-uae-vat-categories.md)).
- **Each item has one sale price** (4 decimals) and a switch **"Price includes VAT"** (yes / no). Both are set on the item screen.
- **Every tax invoice shows the VAT separately, for every customer:** net, VAT and total, per line and in the totals ([0009](0009-vat-per-line.md)). This covers A4 invoices and POS receipts.
  - If the price includes VAT, the system works the net and the VAT back out of it.
  - If it does not, the system adds the VAT on top.
- **Customer type is required:** Individual / Contractor / Company. It is used for reports now.
- **Ready for later, not built now:** a second price level (for example "Contractors & companies") can be added later. It would hold its own price per item and apply to chosen customer types. There is no screen for it in M2.

## Why
- One price per item is simpler to enter and to keep right.
- Showing net, VAT and total on every invoice makes the tax clear to every customer and to the Federal Tax Authority.
- Preparing the tables for a second level now means it can be added later without changing existing data.

## How it works
- **Price levels:**
  - `md.price_levels` holds the price levels. M2 seeds one: `STANDARD` ("السعر العادي" / "Standard price"), the default.
  - A level can list the customer types it applies to (`customer_types`). The default level lists none and applies to everyone.
- **Item prices:**
  - `md.item_prices` holds one row per item and level: the price (`price_4dp`) and its own "includes VAT" switch.
  - The item screen shows only the Standard price and its switch.
- **Choosing the price (M4):** the price comes from the level that lists the customer's type, if the item has a price there. Otherwise it comes from the Standard level.
- **The calculation** is the one in [0009](0009-vat-per-line.md):
  - **Price includes VAT:** VAT = line total × rate ÷ (100% + rate), rounded to the fils through the shared helper; net = line total − VAT.
  - **Price excludes VAT:** VAT = net × rate, rounded the same way; total = net + VAT.
- **Customer type:** `md.customers.customer_type` must be `individual`, `contractor` or `company`.
- **The items list** shows each price both with and without VAT.
- **Payment receipts (`RCT-`)** that settle an invoice show the invoice they pay. The VAT is on that invoice. Payments received before an invoice get their own tax invoice ([0013](0013-advance-and-progress-payments-vat.md)).

## Consequences
- The schema's `md.price_lists` becomes `md.price_levels`, and customers no longer carry a price list.
- The design's single "VAT inclusive / exclusive" switch in Settings is replaced by the switch on each item.
- Simplified tax invoices ([0010](0010-invoice-format-by-vat-registration.md)) also show net, VAT and total. They differ from full tax invoices only in their title and in not showing the customer's TRN.
- PRD 10.1 "Prices can be tax-inclusive or tax-exclusive, set per price list" now reads "set per item".
