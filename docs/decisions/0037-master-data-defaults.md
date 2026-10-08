# 0037 — Master-data rules: codes, phones, TRNs, logo, never deleted

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-08 |
| **Decided by** | Owner |

## Decision
- **Item code:**
  - The app suggests the next free code, and you may change the suggestion before saving.
  - The code can never change after the item is created.
- **Customer phone:**
  - Required.
  - Stored in the international form (`+971…`).
  - No two customers share a phone number. This also counts deactivated customers: you reactivate the old one instead.
  - The walk-in customer is the only customer without a phone.
- **TRN** (customers and suppliers):
  - 15 digits starting with `100`.
  - Required when the customer or supplier is VAT-registered.
  - No two customers share a TRN, and no two suppliers share one.
- **Company logo:**
  - PNG or JPEG only, at most 512 KB.
  - SVG is refused, because an SVG file can carry hidden code.
  - The file's content is checked, not just its name.
- **Parts that wait for later milestones:**
  - Stock parts of "Items & stock" (on hand, cost, adjustments, labels) stay hidden until M3.
  - Balance parts of "Customers" (balance, aging, statement) stay hidden until M4.
- **Nothing is ever deleted:**
  - Items, customers, suppliers, technicians, accounts, payment methods, warehouses, units, categories and reason codes are **deactivated with a written reason**.
  - Each one can be reactivated.

## Why
- **Codes:** a fixed code keeps old invoices, labels and stock records pointing at the right item.
- **Phone and TRN:** unique numbers stop the same customer from being entered twice and splitting their balance.
- **TRN format:** a wrong TRN makes a full tax invoice invalid (priority 3: correct UAE VAT).
- **Logo:** refusing SVG closes a way to smuggle code into printed documents (priority 2: security).

## How it works
- **In the database:**
  - Code, phone and TRN rules are enforced by checks and unique indexes. The screens and the import check the same rules first.
  - A trigger refuses any change to an item's code.
  - Business records cannot be deleted (golden rule 2).
- **Reasons:** a deactivation needs a reason, which is written to the audit log with the change.
