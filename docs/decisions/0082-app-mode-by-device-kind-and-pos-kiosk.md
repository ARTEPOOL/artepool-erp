# 0082 — One app; the device kind decides the mode; POS PCs run in kiosk mode

| | |
|---|---|
| **Status** | Accepted (2026-10-19) |
| **Date** | 2026-10-18 |
| **Decided by** | Owner |

## Decision
- **One app, one installer.** The mode comes from the kind the PC was enrolled as (decision 0024), never from a second executable or a local switch.
  - **POS PC** → the app starts by itself at Windows sign-in, full screen, in **POS kiosk mode**. Cashiers sign in with their PIN (0021); a user with a password (owner, supervisor) can still sign in there with password + 2-step.
  - **Office PC** → the normal full app with password + 2-step (0021, 0077).
- **Kiosk mode is an app-level lock** (not Windows Assigned Access):
  - full screen, no title bar or window buttons; closing from inside the app (Alt+F4, the close message) is refused;
  - a watchdog restarts the app within a few seconds if its process is closed or crashes (a Windows scheduled task at the cashier's sign-in, set to restart on failure, plus a small watchdog process);
  - Ctrl+Alt+Del cannot be blocked by any app: the installer hardens the cashier's Windows account instead (decision 0085: standard user, Task Manager, Run box, command prompt and registry editor turned off by policy for that account).
- **No Windows shell replacement and no Assigned Access** (owner's choice): the lock stays in the app so the owner can turn it off for maintenance (0089). May be revisited after go-live.
- **Every exit attempt is audited and raises an owner alert:** a refused close, a watchdog restart, the app found not running at the next start, and every unlock (0083). Alerts show on the owner dashboard and in Settings → Devices.
- **Changing a PC's kind** (Settings → Devices) switches its mode at the next start and is audited as today.

## Why
The counter PC must stay on the POS all day, and a cashier must not reach Windows, files or other programs.

## Consequences
- Idle behaviour on POS PCs: [0090](0090-pos-idle-behaviour.md).
- Kiosk mode only works in the Windows app (Tauri); the browser dev mode keeps a normal window.
