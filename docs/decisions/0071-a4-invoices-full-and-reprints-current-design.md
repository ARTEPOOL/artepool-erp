# 0071 — A4 invoices are full tax invoices when the customer's details allow; reprints use today's design

| | |
|---|---|
| **Status** | Accepted (pending accountant review, with 0064) |
| **Date** | 2026-10-17 |
| **Decided by** | Owner |
| **Refines** | [0010](0010-invoice-format-by-vat-registration.md), [0064](0064-print-designer-and-locked-fields.md), [0020](0020-print-template-designer.md) |

## Decision
1. **An A4 invoice (INV-) is a full tax invoice ("Tax Invoice") whenever the customer's details allow it.** Revised the same day: nothing is typed on the invoice, so the details come from the customer only.
   - **VAT-registered customer:** a full tax invoice with their name, address and TRN. Their address must be on file, or the issue is refused.
   - **Named, unregistered customer with an address on file:** a full tax invoice with their name and address, no TRN.
   - **Walk-in cash customer, or a customer without an address:** a simplified tax invoice, which the law allows for an unregistered customer.
   - POS sales, advance (payment) invoices and debit notes follow 0010.
2. **No name or address fields on the invoice.** The owner asked for them to be removed; they come from the customer, filled in automatically. To get a full invoice, add the customer's address in the customer record.
3. **Reprints use today's design** (colours, logo, layout, optional fields).
   - The content of the document never changes: its number, date, lines, amounts, customer and the seller's details as issued.
   - Every document still stores the design version it was first printed with, for the record.
   - The locked tax fields always print.

## Why
- The owner wants every A4 invoice to read "Tax Invoice".
- Old invoices printed in old colours looked inconsistent; only the look changes, never the content.

## Consequences
- Migrations 0025 and 0027 hold the format check and the issue rule.
- An unregistered customer's A4 invoice is never refused for lack of an address.
