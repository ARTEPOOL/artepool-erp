# 0064 — The print designer (M4b) and the fields that can never be hidden

| | |
|---|---|
| **Status** | Accepted. **The locked-field lists are pending the accountant's review before go-live.** |
| **Date** | 2026-10-14 |
| **Decided by** | Owner |
| **Refines** | [0020](0020-print-template-designer.md), [0050](0050-print-designer-after-m4.md), [0062](0062-pos-receipt-and-customer.md) |

## Decision
- **Settings → Print designer** (owner only, `print_templates.manage`) has four tabs: **A4 invoice**, **Quotation**, **Credit note**, **Thermal receipt**. Each tab shows a live preview.
- The tab buttons are **Default** (go back to the original design), **Test print** and **Save**. Every save makes a new, immutable template version, and the save is written to the audit log.
- **Receipts and statements** print with the A4 invoice's design (logo, colour, language, text size, margins, footer).
- **The thermal receipt's language** now lives in the designer (receipt tab). The old setting `print.receipt_language` is no longer used. Migration 0023 copies its value into the receipt template.
- **Options:**
  - logo on or off, its position (beside the seller details, centred, opposite side) and size;
  - main colour (A4 only);
  - language (Arabic + English, Arabic, English);
  - text size (small, normal, large);
  - margins (narrow, normal, wide) for A4, and width (80 mm or 58 mm) for the thermal receipt;
  - texts: welcome line, terms and notes, footer, each in Arabic and English;
  - optional fields, listed below.
- **The QR code is not printed** for now ([0067](0067-qr-code-deferred.md)).

## Locked fields (always printed; the designer shows them as "Required" and cannot hide them)

Based on the UAE VAT Executive Regulation (Article 59 for tax invoices, Article 60 for tax credit notes). **The accountant must confirm these lists before go-live.**

### Full tax invoice (A4 `INV-`, and a POS sale to a VAT-registered customer)
1. The words **"Tax Invoice"** (title).
2. **Seller:** name, address, TRN.
3. **Customer:** name, address, TRN.
4. Sequential **invoice number** and **date of issue**.
5. **Date of supply**, when different from the date of issue.
6. Per line: **description, quantity, unit price, discount** (when any line has one), **taxable amount, VAT rate, VAT amount, line total**, all in AED.
7. **Totals:** total discount (when any), taxable amount, VAT amount, total payable, in AED.
8. For an advance or progress payment invoice and for the final invoice: the earlier payments deducted and their VAT ([0013](0013-advance-and-progress-payments-vat.md)).

### Simplified tax invoice (POS `POS-`, and A4 `INV-` for a customer who is not VAT-registered)
1. The words **"Tax Invoice"** (title: "Simplified Tax Invoice").
2. **Seller:** name, address, TRN.
3. **Invoice number** and **date of issue**.
4. **Description** of the goods or services (per line).
5. **Total payable** and **VAT amount**, in AED.

### Tax credit note (A4 and POS returns)
1. The words **"Tax Credit Note"** (title).
2. **Seller:** name, address, TRN.
3. **Customer:** name; address and TRN when the customer is VAT-registered.
4. Credit note **number** and **date of issue**.
5. The **original tax invoice's number and date**.
6. Per line: **description, quantity, unit price, taxable amount, VAT rate, VAT amount, total**.
7. **Totals:** taxable amount, VAT amount, total, in AED.
8. The **reason** for the credit note.

### Quotation, receipt (سند قبض) and statement (not tax documents)
- Locked only: the **title**, the **seller's name**, the **number** and the **date**.
- **Optional:** the seller's address and TRN, and the customer's address.

## Optional fields (the owner turns them on or off)
- Seller phone and email.
- Welcome line.
- **Customer address:** optional only on simplified invoices, quotations, receipts and statements. It is locked on full tax invoices and on credit notes for VAT-registered customers.
- Customer phone.
- **Customer PO number**: printed only when filled ([0066](0066-customer-po-number.md)).
- Item code.
- Amount in words (Arabic and English).
- **Bank details**: the chosen bank account ([0065](0065-company-bank-accounts.md)).
- Terms and notes.
- Received-by and signature boxes (A4).
- Salesperson (A4) and cashier name (thermal).
- Due date.
- **Line discount column:** only on quotations, or on a tax document that has no discount at all.

## Consequences
- **A full tax invoice is refused at issue when the customer has no address**, both at the POS and in the A4 section. The database enforces this, so a non-compliant invoice cannot be issued. Error: "This customer is VAT-registered: add their address before issuing a full tax invoice."
- Documents issued before this change reprint with their own template version, as before.
- The thermal receipt prints the customer's address on a full tax invoice.
