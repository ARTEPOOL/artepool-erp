# 0036 — New customers start as cash; credit is a permissioned, audited change

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-08 |
| **Decided by** | Owner |

## Decision
- **Every new customer starts as "Cash":** credit limit 0 and payment terms "on receipt". This includes customers created at the POS and customers imported from Excel.
- **Only some people can change a customer's credit,** with the new permission `customers.credit` ("Give customers credit"). This covers:
  - switching a customer to "Credit", with a credit limit and payment terms
  - changing the limit or the terms
  - switching back to "Cash"
- **By default only the Owner and Accountant roles** have `customers.credit`. The Cashier role can add customers, but always as cash.
- **Every credit change needs a written reason.** It is written to the audit log with the old and new values.

## Why
- Credit is money owed to the company. Deciding who gets it, and how much, should be a deliberate and traceable act.

## How it works
- **Customer fields:**
  - `md.customers.credit_mode`: `cash` or `credit`
  - **Cash:** limit 0 and terms 0 days
  - **Credit:** a limit above 0 and terms from 0 to 365 days
- **Enforced in the database:** the database refuses a credit change from a user without `customers.credit`, or without a reason. The API checks the same rules first.
- **Walk-in customer:** it is always cash.
- **From M4:** credit sales check the limit. Going over it needs a supervisor approval (`sales.credit_over_limit`).

## Consequences
- **Customer form:** the payment-terms and credit-limit fields are shown only to people with `customers.credit`.
- **Default terms:** the design's default of 30 days is replaced by "on receipt".
