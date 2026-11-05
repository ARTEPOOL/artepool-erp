# 0117 — A4 documents print the unit price and the discount excluding VAT

| | |
|---|---|
| **Status** | Accepted (2026-11-04) |
| **Date** | 2026-11-04 |
| **Decided by** | Owner (allowed either option: unit price excluding VAT, or inclusive prices clearly marked; this is the recommended one) |
| **Changes** | [0064](0064-print-designer-and-locked-fields.md) (what the line's unit price shows); [0032](0032-one-sale-price-with-vat-flag-and-customer-types.md) unchanged (the item's own price) |

## Decision
1. On every A4 document, the line table's **unit price is excluding VAT**, on the same basis as the taxable amount and the VAT columns next to it.
   - This covers simplified and full tax invoices, credit and debit notes, advance payment invoices, final invoices, A4 copies of POS sales, and quotations.
   - An item sold at 189.00 including VAT prints **180.00**, with taxable 360.00 for two.
2. The line's **discount** and the **"Total discount"** are also printed excluding VAT.
3. A deduction line on a final invoice (an earlier advance payment) shows its net amount as the unit price.
4. The item's own price does not change: it is still entered including or excluding VAT ([0032](0032-one-sale-price-with-vat-flag-and-customer-types.md)). The shelf price, the label and the POS screen still show the price the customer pays.

## Why
- One line had a unit price including VAT (189.00) next to a taxable amount excluding it (360.00), which confused the reader.
- UAE e-invoicing (PINT-AE) carries the item's net price, excluding VAT. Printing the same now means nothing changes on paper when e-invoicing starts.
- The VAT and the totals themselves are unchanged: only the printed unit price and discount are expressed differently.

## How it works
- The inclusive price is split back with the shared helper `unitPriceExclVat4dp`: price ÷ (100% + rate), kept at 4 decimals, rounded half away from zero (golden rule 1). Tested, including a property test against the line's net.
- The printing service does the conversion when it builds the lines (`printLine`); the stored document is not changed.
- The test `print-documents.test.ts` checks that the simplified invoice prints 180.00 and never 189.00.

## Consequences
- Old documents reprinted after this change also show the unit price excluding VAT. Their amounts, VAT and totals are the same (content unchanged, [0071](0071-a4-invoices-full-and-reprints-current-design.md)).
- The thermal receipt keeps its own layout (Item / Amount, [0070](0070-receipt-printer-modes-and-layout.md)).
- Quantity × printed unit price can differ from the taxable amount by a fils on an inclusive price, because the taxable amount comes from the inclusive total. The taxable amount, VAT and total stay the exact values.
