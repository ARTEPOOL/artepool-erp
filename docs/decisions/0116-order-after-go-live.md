# 0116 — The order after go-live: Phase 2 (money) first, then the AI & Online track with Phase 3; e-invoicing ready before 1 July 2027

| | |
|---|---|
| **Status** | Accepted (2026-11-04) |
| **Date** | 2026-11-04 |
| **Decided by** | Owner |
| **Changes** | PRD §13 (phases), §10.4; [0019](0019-einvoicing-via-accredited-provider.md) (a deadline added) |

## Decision
1. **Phase 2 — Money comes first after go-live:**
   - purchases and suppliers;
   - expenses;
   - the accounting screens and reports;
   - the VAT return.

   Recovering input VAT and filing the quarterly VAT return depend on it.
2. **Then the AI & Online track, stages 2A–2D,** interleaved with **Phase 3** (maintenance contracts, visits, service jobs, construction projects), in the order the owner decides each time.
   - The track is **not "Phase 2"**: it is a separate track with its own stages and its own plan document.
3. **E-invoicing must be ready before 1 July 2027,** whatever phase the rest of the work is in.
   - It no longer waits for P4.
   - The exact legal date that applies to ARTÉPOOL stays a setting (`einvoice.mandatory_from`), confirmed by the accountant ([0019](0019-einvoicing-via-accredited-provider.md)).
   - The provider (ASP) is chosen early enough to build and test the integration before that date.

## Why
- Without purchases and input VAT, the shop pays more VAT than it owes and cannot file a complete return. So money comes first.
- The AI & Online work and the operations work (Phase 3) both help the business. The owner decides their order as needs come.
- E-invoicing has a legal deadline, so it gets a date of its own instead of a place at the end of the list.

## How it works
- The PRD's phase table shows this order.
- P4 keeps the remaining extensions: WhatsApp/email, promotions, loyalty, multi-warehouse screens, standby server.
- The AI & Online track's stages 2A–2D are described in its own plan document, `docs/ai-online-track.md` (to be added from the owner's draft).
- Each stage is planned and approved before it is built, like every milestone.
