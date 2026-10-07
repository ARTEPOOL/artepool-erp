# 0026 — Users and devices are never deleted: deactivate or revoke, with a reason

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Decided by** | Owner |

## Decision
Nothing is ever deleted (golden rule 2). Applied to access control:

| Record | Instead of deleting |
|---|---|
| **User** | **Deactivate**, with a **required reason**. They can no longer sign in, and their open sessions end immediately. Their name stays on documents and in the audit log. The owner can **reactivate** them later. The owner account cannot be deactivated. |
| **Device (PC)** | **Revoke**, with a **required reason**. Its sessions end immediately, and its next request is refused. **This cannot be undone.** The same PC can come back only through a new enrollment, as a new device record. The old record stays. The server and the PC you are using cannot be revoked from the screen. |
| **Role** | Custom roles are deactivated, never deleted. The five default roles cannot be deactivated. |
| **Session** | Ended with a reason (sign-out, idle lock, expiry, revoke, password change, device revoked). It is never deleted. |
| **Enrollment code, recovery code, approval** | Marked as used, cancelled or expired. Never deleted. |

## Why
- Documents and the audit log must always say who did what and on which PC, years later.

## How it works
- **Where the reason is kept:** on the record itself (`deactivation_reason`, `revoke_reason`) and in the audit log, with old and new values.
- **Database:** blocks `DELETE` on all of these tables.
- **Links:** removing a permission from a role, or a role from a user, removes only the **link**. The removal is recorded in the audit log with the old value, who did it and when.
- **The one technical exception, already in the approved schema:** idempotency keys are purged after 30 days. They are the records the server keeps so a retried save does not count twice. They contain no business data.

## Consequences
- **No delete buttons:** the user and device screens have none, only "Deactivate" and "Revoke", each asking for a reason.
