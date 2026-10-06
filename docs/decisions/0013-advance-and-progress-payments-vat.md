# 0013 — Advance and progress payments: VAT when each payment is received

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner / accountant |

## Decision
- **VAT is charged on every payment when it is received,** whatever the stage: advance, during construction or after completion.
- **Each such payment produces its own tax document:** a tax invoice for the payment received, numbered in the `INV-` series.
- **The final project invoice deducts the previous payments and their VAT,** so VAT is never counted twice.
- This **replaces** the earlier P1 restriction "payments against invoices only".

## How it is applied
- **When a payment creates its own tax invoice:** a payment that is **not** settling an already-issued tax invoice gets its own tax invoice. This covers advances, progress payments, payments after completion before the final invoice, and any excess paid above an invoice.
- **When it does not:** a payment that settles an already-issued tax invoice does **not** create VAT again, because that invoice already charged it. This is what keeps VAT from being counted twice.
- **The amount received includes VAT** at the rate of the agreed work (normally 5%): VAT = amount × 5/105.
- **Link to the agreement:** the payment can be linked to the customer's accepted quotation (and to a project from P3). The final invoice then offers those payments for deduction automatically.
- **Cancelled work:** if the work is cancelled, the payment's tax invoice is reversed with a credit note and the money is refunded.

## Example (construction contract 100,000 + VAT 5,000 = 105,000 AED)

| Document | Net | VAT | Total |
|---|---|---|---|
| Advance received: tax invoice INV-000201 | 30,000.00 | 1,500.00 | 31,500.00 |
| Progress payment: tax invoice INV-000250 | 40,000.00 | 2,000.00 | 42,000.00 |
| Final invoice INV-000300: pool construction | 100,000.00 | 5,000.00 | 105,000.00 |
| — less INV-000201 | −30,000.00 | −1,500.00 | −31,500.00 |
| — less INV-000250 | −40,000.00 | −2,000.00 | −42,000.00 |
| **Final invoice balance due** | **30,000.00** | **1,500.00** | **31,500.00** |

The VAT declared over time is 1,500 + 2,000 + 1,500 = **5,000**, exactly once.

## Accounting (see the posting map)
- **Payment tax invoice:** the net is recorded as **Customer advances** (a liability, because the work is not yet delivered) and the VAT as **VAT payable**.
- **Final invoice:** the full value becomes **revenue** for the relevant line of business. The customer advances are released, and only the remaining VAT is added.
