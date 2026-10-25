# 0105 — The server's address: a router reservation, a stable name, a clear message when it moves

| | |
|---|---|
| **Status** | Accepted (2026-10-20) |
| **Date** | 2026-10-20 |
| **Decided by** | Owner |
| **Related** | [0024](0024-device-enrollment-proves-the-server.md), [0093](0093-no-remote-access-in-phase-1.md), [0085](0085-server-on-the-pos-pc.md) |

## Decision
- **The server PC keeps one address** through a **DHCP reservation on the router**, made by the owner or a technician. The Arabic guide explains it step by step.
- **The app never changes Windows network settings.**
- **The other PCs find the server by its name** (the server PC's Windows computer name, chosen at installation, e.g. `ARTEPOOL-SERVER`), not only by its address. The server's certificate carries the name and the address at installation; the PCs connect by name.
- **When the server cannot be reached**, the app says plainly which server it looked for (name and last known address) and what to check:
  - the server PC is on and connected;
  - the router still gives it the reserved address;
  - with the guide's section on the reservation.

  When the name answers at another address, the app says the server's address changed and that the router reservation should be checked.

## Why
A changed address must never look like a broken system. With a stable name and a reserved address, the shop keeps working when the router restarts; and when something does change, the message tells the owner exactly what to fix.
