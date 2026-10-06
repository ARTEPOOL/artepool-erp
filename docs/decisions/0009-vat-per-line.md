# 0009 — VAT calculated per line

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner / accountant |

## Decision
- **VAT is calculated on each line.** The invoice VAT total is the **sum of the line VAT**.
- **VAT is shown per line and in the total.**
- **VAT applies to every customer.** The standard rate is 5%. The rate is configurable per item through its VAT category (standard, zero-rated, exempt, out of scope).

## How it works
- **Price excludes VAT:** net = (quantity × unit price) − discounts. VAT = net × rate, rounded to the fils. Line total = net + VAT.
- **Price includes VAT:** line total = (quantity × unit price) − discounts. VAT = line total × rate ÷ (100% + rate), rounded to the fils. Net = line total − VAT.
- **Rounding:** half away from zero, to the fils, through the single shared rounding helper.
- **Example** (price including VAT): 9.99 AED gives VAT 0.48 and net 9.51.
- **Document totals** are always sums of line values. They are never calculated separately.
- **No cash rounding** (see 0014).
