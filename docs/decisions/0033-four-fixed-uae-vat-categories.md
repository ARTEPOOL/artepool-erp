# 0033 — Four fixed UAE VAT categories; only the owner changes a rate

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-08 |
| **Decided by** | Owner |

## Decision
- **There are exactly four VAT categories,** as in UAE law:

  | Code | Category | Rate |
  |---|---|---|
  | `SR` | Standard | 5% |
  | `ZR` | Zero-rated | 0% |
  | `EX` | Exempt | — |
  | `OS` | Out of scope | — |

- **No category can be added or removed.** The design's "New category" button is not built.
- **Only the owner can change a rate,** for example if the law changes.
  - A written reason is required.
  - The change applies to **new documents only**.
  - The change is written to the audit log (old rate, new rate, who, when, why).

## Why
- UAE VAT has these four treatments only. A made-up category or rate would produce wrong tax invoices (priority 3: correct UAE VAT).

## How it works
- **Fixed in the database:** migration 0009 seeds the four categories. The API's database role may change only the rate, never insert or deactivate a category.
- **Owner only:** a database rule accepts a rate change only from a user with `system.settings.edit`, which is owner-only. A reason is required.
- **Rates that cannot change:**
  - The zero-rated, exempt and out-of-scope rates always stay 0%.
  - The standard rate is always above 0%.
- **Old documents are safe:** every document line copies the category code and rate when it is issued ([0009](0009-vat-per-line.md)), so a later change never alters them.
- **Where to see them:** Settings → Lists → VAT categories ([0034](0034-master-data-screen-placement.md)).

## Consequences
- **Default category:** every item has a VAT category, Standard 5% unless chosen otherwise.
- **What a customer pays:** the customer's type never changes the category ([0032](0032-one-sale-price-with-vat-flag-and-customer-types.md)).
