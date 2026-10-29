# 0111 — Power loss: confirmed sales survive, a check after every start, and the POS shows its last invoice

| | |
|---|---|
| **Status** | Accepted (2026-10-29) |
| **Date** | 2026-10-29 |
| **Decided by** | Owner |
| **Related** | M6.2 part I; [0085](0085-server-on-the-pos-pc.md) the POS PC is also the server; [0086](0086-backups-local-and-google-drive.md) integrity checks; [0103](0103-upgrades-and-uninstall-never-touch-data.md) upgrades |

## Decision

- **A confirmed sale survives a power cut.** The database runs with `fsync`, `synchronous_commit` and `full_page_writes` on, and on Windows `wal_sync_method = fsync`, so a sale is on the disk (through the disk's own write cache) before the program says "done". Data checksums (set at install) find a damaged page. The server setup writes these settings; an upgrade or a reinstall turns on any that are off. System health → Server PC shows "Protection from power cuts" and alerts the owner if one is off.
- **A sale cut off half way leaves nothing.** A sale is one transaction (golden rule 4) and takes its number inside it (rule 5): when the power or the connection goes before the end, nothing of it stays and no number is used. The cashier's retry with the same operation key makes exactly one sale.
- **An integrity check after every start.** The backup service runs the integrity checks once after each start of the database (after a power cut too), not only at night; System health shows the last start and that check, and a failure alerts the owner.
- **The POS shows the shift's last invoice, always** (owner's choice, 2026-10-29): number, time and total with "Reprint", under "New sale". After a power cut the cart is empty, and this tells the cashier whether the last sale went through before ringing it again.

On Windows, `fsync` flushes through the disk's write cache (PostgreSQL's documentation names it for this); the default `open_datasync` does not. PostgreSQL 18 no longer accepts `fsync_writethrough` on Windows: a server with it set does not start (found by the Windows installer test in CI).

## Why

The POS PC is also the server (0085): a power cut stops both at once, often right when the cashier presses "Pay". The cart lives in memory and is lost; without the last invoice in view, a sale that went through could be rung a second time.

## How it is checked

- An integration test kills the database connection of a sale while it waits for its number: the invoice stays a draft, no number is used, nothing moved, the integrity checks pass, and the retry makes one sale with the next number.
- Another stops a real PostgreSQL server of its own the way a power cut does (`pg_ctl -m immediate`) during a sale: after recovery the confirmed sale is whole, nothing of the cut one is, and every check passes.
- On the VM (before the shop PC): switch the VM off during a sale, start it, and look at System health and the POS's last invoice.
