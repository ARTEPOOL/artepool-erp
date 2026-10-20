# 0099 — Labels for many items at once, and the "price changed, label is old" list

| | |
|---|---|
| **Status** | Accepted (2026-10-20) |
| **Date** | 2026-10-20 |
| **Decided by** | Owner |
| **Related** | [0097](0097-label-designer-and-print-quality.md) (the next step it named), [0096](0096-barcode-labels-2-inch-printer.md), [0033](0033-four-fixed-uae-vat-categories.md) (VAT rates) |

## Decision

**A record of every label print.** Each time labels are printed (one item or many), the server records, per item: the price printed (the 4-decimal sale price, "price includes VAT", the VAT rate, and the price with VAT that was on the label), the number of labels, the size, the design version, who printed and on which PC. The record is audited and never changed or deleted.
- The screen sends the price it printed; when the item's price (or "price includes VAT", or the rate of its VAT category) changed in the meantime, nothing is recorded and the screen says the price has changed, so the labels can be printed again with the new price.

**Labels for many items** (Items & stock → "Labels for many items"), three ways to fill the list:
1. Add items by search or scanner, with the number of labels per item.
2. From a stock increase or the opening stock: its items, with the number of labels = the quantity that came in (whole units); later the purchase receipt joins here.
3. **"Price changed":** every active item whose price on its last printed label is not its price today. A change of the price, of "price includes VAT", of the item's VAT category, or of that category's rate all count (the price on the label changes). Items never printed are not in this list. The list can be filtered by category.
- **Number of labels by default:**
  - "Price changed" list: the quantity on hand for items counted in units; 0 when on hand is zero or negative.
  - Items sold by weight or length (kg, m, …): 1 label per item.
  - From a stock increase or opening stock: the quantity received for unit items; 1 for weight or length items.
- The **total number of labels** is always shown before printing; above **100 labels** the screen asks to confirm.
- One size and the saved design for the whole batch; printed silently on the PC's label printer (or through the print dialog as a fallback); recorded after the labels were sent.

**Permission:** `labels.print` (as for one item). The "price changed" list shows prices only, never costs.

## Consequences

- New table `inv.label_prints` (migration 0041), audited, never deleted.
- Once an item's labels are printed with its new price, it leaves the "price changed" list.
