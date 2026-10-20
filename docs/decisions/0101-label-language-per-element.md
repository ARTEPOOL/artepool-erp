# 0101 — A language for each label element; "both" puts the English line under the Arabic one

| | |
|---|---|
| **Status** | Accepted (2026-10-20) |
| **Date** | 2026-10-20 |
| **Decided by** | Owner |
| **Related** | [0097](0097-label-designer-and-print-quality.md) (extends the label designer) |

## Context

With the label's language set to "both", the shop's name printed as "Arabic / English" on one line, so the English part was cut ("ARTE SWIMMING PO…"); and the price always followed the label's one language setting, so the Arabic price could not be dropped while keeping the English one.

## Decision

- **"Both" means two lines:** the Arabic line, then the English line under it, for every element in two languages: shop name, sale pack, price, "incl. VAT", expiry, batch. Two languages never share a line.
- **Each of these elements has its own language** in the label designer: "As the design" (the label's main language; the default, so saved designs print as before), Arabic, English or both. Example: the price in English only ("AED 120.00"), the shop name in both.
- **A size can change it** too (Print designer → changes for one size), e.g. the price in Arabic only on 40 × 30.
- Elements in one language (Arabic name, English name, item code, print date, free text) have no language choice.

## Consequences

- No database change: the language is an optional part of the saved design; designs saved before keep printing the same.
- Tests: the shop name in both on two lines, Arabic first, never "ar / en"; the price in English only; the sale pack in Arabic only; a per-size language; "any design" property test with a random language per element (nothing overlaps, the barcode never below its minimum); the designer saving the choices; the real label in a browser in Arabic and English.
