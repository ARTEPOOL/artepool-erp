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
- **Stock value** (per item and warehouse) is kept with 4-decimal precision, so the weighted-average cost is exact to 4 decimals.
- **Cost of goods leaving** = quantity × average, at 4 decimals. When the last unit leaves, exactly the remaining value leaves with it.
- **Books follow the stock to the fils.** The amount booked in the accounts for each stock movement is the change in the stock value **rounded to the fils**. The accounts therefore always equal the stock value rounded to the fils, and rounding never builds up.

  Example: receive 10 × 1.2345 = 12.3450 (booked 12.35); issue 3 = 3.7035 (booked 3.71); issue the last 7 = 8.6415 (booked 8.64). Stock and books both end at exactly 0.00.
- **Confirmed by the owner (2026-10-07):** a 1-fils difference in a single movement's cost is acceptable, because the books always match the stock value exactly.
- **One rounding rule in two places:** the same rule is used by the TypeScript helper and by the database's costing function. Both run one shared set of test cases.
