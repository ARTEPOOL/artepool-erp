# 0014 — Money precision and rounding

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner / accountant |

## Decision
- **No cash rounding.** Document totals are exact to the fils (2 decimals).
- **Unit prices, unit costs and weighted-average cost** use **4-decimal precision**.
- **Totals are rounded to the fils only through the shared, tested rounding helper,** half away from zero.
- Golden rule 1 in `CLAUDE.md` is updated accordingly.

## How it is stored (never floating point)

| What | Stored as | Example |
|---|---|---|
| Amounts and totals | Integer fils, `*_fils` | 100.50 AED → `10050` |
| Unit prices, unit costs, average cost | Integer AED × 10,000, `*_4dp` | 1.2345 AED → `12345` |
| Quantities | Exact decimal, 3 places | 2.500 kg |
| Rates | Basis points | 5% → `500` |

## How it works
- **Line amounts:** quantity × unit price is rounded to the fils by the helper. Example: 3 × 1.2345 = 3.7035 → 3.70.
- **Stock value:** each item's stock value (per warehouse) is kept exactly in fils, matching the accounts. The average cost is that value ÷ quantity, kept to 4 decimals.
- **Cost of goods leaving:** quantity × average, rounded to the fils. When the last unit leaves, exactly the remaining value leaves with it. Stock value and the accounts therefore always agree to the fils, with no rounding leftovers.
- **One rounding rule in two places:** the same rule is used by the TypeScript helper and by the database's costing function. Both run one shared set of test cases.
