# 0093 — No remote access in Phase 1; the laptop works on the shop LAN

| | |
|---|---|
| **Status** | Accepted (2026-10-19) |
| **Date** | 2026-10-19 |
| **Decided by** | Owner |
| **Replaces for Phase 1** | [0084](0084-remote-access-through-private-vpn.md) (deferred) |

## Decision
- **No remote-access VPN in Phase 1** (no Tailscale or any other). The owner's laptop works **on the shop LAN only**.
- **No router port is ever opened**, and no remote-desktop tool (AnyDesk, TeamViewer or similar) is used as a replacement.
- **The design stays VPN-agnostic:** the app talks to the server by name or address over HTTPS with the ARTÉPOOL CA, so remote access can be added later (0084) without changing the app.
- **Remote monitoring** comes with the read-only mobile dashboard in Phase 2 (0088).
- When the owner is away, the POS PC is unlocked with the offline **"Unlock with owner code"** on its lock screen (0083, 0091).
- The firewall on the server allows the API port from the LAN only.

## Why
The owner prefers no remote access until the system runs at the shop; it removes a whole class of risks for go-live.

## Consequences
- The "outside the LAN always needs the phone code" rule of 0084 is not built now; it returns with remote access.
