# 0119 — Acceptance by an automated rehearsal and a guided hardware check; go-live from a clean database

| | |
|---|---|
| **Status** | Accepted (2026-11-05) |
| **Date** | 2026-11-05 |
| **Decided by** | Owner (approving the M7 plan with one change: no manual rehearsal sales) |
| **Changes** | PRD §13 (P1 "done when"), phase plan M7 and §6.3 (the manual full day on 2+ tills) |
| **Plan** | [`milestones/m7-acceptance-tools.md`](../milestones/m7-acceptance-tools.md) |

## Decision

1. **No manual rehearsal sales.** The rehearsal is fully automated:
   - **On the shop's server PC.** A **«ابدأ البروفة» / "Start rehearsal"** button on System health (owner only) runs a scripted day against a **separate rehearsal database** on the real server PC, through the server's real API code. The day includes:
     - POS sales;
     - A4 invoices, receipts, returns and credit notes;
     - discounts and an oversell approval;
     - shifts opened and closed with counts;
     - cash in and out;
     - label print jobs;
     - every other case.

     It then runs the reconciliation report automatically and shows green or red. The rehearsal database is dropped at the end; the live data is never touched.
   - **In CI.** The busy day with 4 cashiers and 800+ sales runs every night and before every release.
2. **The only human step** is a guided **hardware check** of about 5 minutes:
   - print a test receipt;
   - open the drawer;
   - print a test label;
   - scan the test label's barcode.

   The owner presses «تمام» or «فيه مشكلة» for each step.
3. **Go-live starts from a clean database.**
   - The export covers items, customers and suppliers.
   - Opening stock and customer opening balances are entered on go-live day, by the owner only (0042, 0051).
4. **The reconciliation report** is visible to the owner and the accountant. **The speed line** stays on System health permanently.

## Why

- A scripted rehearsal covers every case every time, can be repeated after any update, and costs the shop no working day.
- Running it on the real server PC proves the real installation, its database and its speed. The hardware check covers what software cannot press: paper, the drawer, the scanner.
- Posted documents are never deleted, so the documents made while testing cannot stay in the books. A clean database is the only start that keeps the golden rules.

## How it works

- **One rehearsal engine serves both runs:**
  - on the shop PC: the updater starts `artepool-svc run rehearsal` at low priority;
  - in CI: `pnpm acceptance:day`.
- **Its own database only.** The engine creates `artepool_rehearsal_<run>`, migrates it, seeds it, and enrolls its tills and office PC through the normal enrollment flow. It can drop only a database with that prefix and its own marker.
- **Refused** while a shift is open, while an update is installing, or with less than 2 GB of free disk.
- **Results** (each step, the seven-step report, speed) are kept in `ops.rehearsal_runs`. Hardware check results are kept in `ops.hardware_checks`. Both are audited.
- **The laptop's screens are not driven automatically.** That would need remote control, which the shop doesn't allow ([0093](0093-no-remote-access-in-phase-1.md)). The office work runs as a simulated office PC, and the laptop has an optional A4 test page in the hardware check.

## Consequences

- PRD §13's P1 acceptance becomes:
  - the automated rehearsal on the shop's server PC is green;
  - the CI busy day (4 tills, 800+ sales) is green;
  - the hardware check is all «تمام»;
  - a backup restores.
- **Ready for go-live** = rehearsal green + hardware check OK + the accountant's sign-off (0018).
