# 0069 — Stuck shifts: close from another PC, the drawer moves with its PC

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-17 |
| **Decided by** | Owner |
| **Refines** | [0004](0004-one-cashier-per-drawer-shift.md), [0026](0026-users-and-devices-never-deleted.md) |

## Problem
A shift is open on a PC's drawer, and that PC is then enrolled again (for example after a name clash), breaks or is gone. The shift stays open forever: only its cashier can close it, and only on that PC. Because a cashier has one open shift at a time, they can no longer open a shift anywhere.

## Decision
1. **Close a stuck shift from another PC.** In **Shifts & cash**, the owner or the accountant (new permission `shifts.force_close`) closes an open shift from another PC, with a **reason** and a **count of the drawer's cash** (the same note-and-coin count). It all happens in one transaction: the count, the closing transfer of the counted cash to the safe, and the close.
   - The over/short stays the **shift's cashier's** (0004) and is accepted later by the owner or the accountant as usual (0058). There is no new accounting treatment.
   - The shift keeps who closed it and why (`force_closed_by`, `force_close_reason`). The list shows "Closed from another PC".
   - A shift open on the same PC is closed at the POS, never this way.
2. **The drawer moves with its PC.** When a PC is enrolled again, the owner moves the old enrollment's drawer to the new one in **Settings → Devices → Move drawer**, with a reason. The drawer keeps its code and history, and its open shift if any. A drawer the new enrollment already made, with no open shift, is set aside (inactive, with the reason). A drawer moves only from a revoked PC to an active point-of-sale PC.
3. **No revoking a PC with an open shift.** Revoking a PC whose drawer has an open shift is refused. Close the shift first, at the POS or as a stuck shift.

The database enforces all three: the permission, open shifts only, once per shift, the moving rules and the revoke guard.

## Why
- The cash in the drawer has to be counted and returned to the safe, whatever happened to the PC.
- The physical drawer stays with the PC. Re-enrolling should not split its history across two drawers.

## Consequences
- Every step is audited: the reason is written to the audit log with the change.
- Two cashiers on the network keep working as before: one PC, one drawer, one shift each.
