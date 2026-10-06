# 0010 — Invoice format follows the customer's VAT registration

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner / accountant |

## Decision
- Customer **not VAT-registered**: the system issues a **simplified tax invoice**.
- Customer **VAT-registered**: the system issues a **full tax invoice** showing the customer's **TRN**.

This applies in the POS and in the Invoices (A4) section, and to credit and debit notes.

## How it works
- **Customer record:** each customer has "VAT registered: yes/no" and a TRN. The TRN must be 15 digits and is required when the customer is registered.
- **At issue:** the format is chosen automatically. The database also enforces it: a full tax invoice must carry a TRN, and a simplified one must not.
- **Walk-in "Cash customer"** always gets a simplified tax invoice.
- **Snapshots:** the customer's name, address and TRN are copied onto the document when it is issued. Editing the customer later never changes old invoices.
