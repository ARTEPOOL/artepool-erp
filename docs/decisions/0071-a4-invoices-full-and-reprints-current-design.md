# 0071 — A4 invoices are full tax invoices; reprints use today's design

| | |
|---|---|
| **Status** | Accepted (pending accountant review, with 0064) |
| **Date** | 2026-10-17 |
| **Decided by** | Owner |
| **Refines** | [0010](0010-invoice-format-by-vat-registration.md), [0064](0064-print-designer-and-locked-fields.md), [0020](0020-print-template-designer.md) |

## Decision
1. **Every A4 invoice (INV-) is a full tax invoice ("Tax Invoice"), whatever the customer's VAT registration.**
   - A full tax invoice is always acceptable under the UAE VAT rules.
   - It carries the customer's name and address, and the customer's TRN only when they are registered.
   - **POS sales** keep following the customer: simplified for an unregistered customer, full for a registered one (0010).
   - **Advance (payment) invoices** and **debit notes** also keep following the customer.
2. **The customer's name and address on the A4 invoice:**
   - The address comes from the customer's record, or is typed on the invoice. A typed address wins.
   - For the shared **cash customer** ("عميل نقدي"), the real name is typed on the invoice.
   - The database refuses to issue while the name is still "Cash customer" (`FULL_INVOICE_NAME`), or while there is no address (`FULL_INVOICE_ADDRESS`).
3. **Reprints use today's design** (colours, logo, layout, optional fields).
   - The content of the document never changes: its number, date, lines, amounts, customer and the seller's details as issued.
   - Every document still stores the design version it was first printed with, for the record.
   - The locked tax fields always print.

## Why
- The owner wants every A4 invoice to read "Tax Invoice".
- Old invoices printed in old colours looked inconsistent; only the look changes, never the content.

## Consequences
- Customers without an address need one, saved or typed, before an A4 invoice is issued to them.
- Migration 0025 changes the format check and the issue rule.
