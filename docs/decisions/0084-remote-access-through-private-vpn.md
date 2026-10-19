# 0084 — Remote access for the owner's laptop through a private VPN only

| | |
|---|---|
| **Status** | Accepted (2026-10-19) |
| **Date** | 2026-10-18 |
| **Decided by** | Owner |

## Decision
- **The API port is never opened to the internet** (no port forwarding on the router, no public address, no cloud relay of the API).
- The owner's laptop reaches the server from outside the shop through **Tailscale** (a private mesh VPN built on WireGuard). The Tailscale account has **2-step verification**; there is **no port forwarding** on the router. Only two machines are in it: the server and the owner's laptop. Its access rules (ACLs) allow **only the owner's laptop** to reach the **API port** on the server, nothing else.
- **Same app, same account** inside the shop (LAN) and outside (VPN). The laptop stays the one enrolled Office PC; it is enrolled once on the shop LAN.
- **Outside the shop, every sign-in needs password + 2-step.** "Trust this PC" (0027, 0077) applies only to requests from the shop LAN (setting `security.lan_networks`, the LAN address ranges); a sign-in from any other address (including the VPN range) always asks for the phone code. Enforced in the database from the session's client address.
- **Revoking:** Settings → Devices → Revoke ends the laptop's access at once (0026), whatever the VPN does; the runbook also says how to remove the laptop from the VPN.
- The server certificate (0024) also names the server's VPN name and address (`pnpm tls:init --renew-server --name … --ip …`).
- **Offline-first stays:** the shop never needs the internet; without it only remote access and the off-site backup wait.
- A runbook `docs/runbooks/remote-access.md` explains the setup and how to remove a device, step by step.

## Why
The owner wants to work from home without putting the shop's server on the internet.
