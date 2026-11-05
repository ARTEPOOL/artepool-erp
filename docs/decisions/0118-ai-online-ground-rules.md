# 0118 — The AI & Online track: its plan and its nine ground rules

| | |
|---|---|
| **Status** | Accepted (2026-11-05) |
| **Date** | 2026-11-05 |
| **Decided by** | Owner (the approved idea list and ground rules in the owner's draft, now [`docs/ai-online-track.md`](../ai-online-track.md)) |
| **Changes** | PRD §3.3, §9.4, §13; [0116](0116-order-after-go-live.md) (the plan document now exists); [0088](0088-no-cloud-database-outbox-for-mobile.md) (the mobile dashboard is stage 2C) |

## Decision

1. **The plan.** The AI & Online track has four stages, described in [`docs/ai-online-track.md`](../ai-online-track.md):
   - **2A, inside the app:** pool chemical dosing calculator, social posts from the stock, an accountant assistant before month close, voice selling at the POS;
   - **2B, WhatsApp:** documents and payment reminders through WhatsApp Business, then an AI assistant for customers;
   - **2C, a secure cloud relay:** the owner's read-only mobile dashboard, then the maintenance technician's mobile app;
   - **2D, after the website is ready:** quote and maintenance requests from the website.

   Its place in the order stays as [0116](0116-order-after-go-live.md) set it: after go-live, P2 (money) first, then this track interleaved with P3, as the owner decides. Nothing is built before the shop is live. Each stage starts only when the owner asks, with a detailed plan approved first.
2. **The nine ground rules**, for every feature of the track:
   1. **Offline-first stays.** Sales, POS, accounting and stock never depend on the internet or on any AI service. Without internet these features wait; the shop keeps working.
   2. **AI only suggests.** Nothing that affects money, VAT, stock, prices, discounts, credit or a promise to a customer is committed without a person's action in the app.
   3. **Minimal personal data.** AI services get only what the task needs: ids and summaries rather than names, phones, addresses or photos of homes. The UAE personal data law (PDPL) principles are followed.
   4. **Audited.** Every AI suggestion accepted or rejected, and every outbound message, is in the audit log (who, when, what, from which PC).
   5. **Controllable.** Each feature has its own permission and an owner-only on/off switch in Settings.
   6. **Outbox.** Every outbound call (AI, WhatsApp, the cloud relay) goes through a persistent outbox with retries and a visible status; nothing is lost while offline.
   7. **One-way cloud.** The cloud receives summaries pushed by the shop server. What comes in (website requests, technician entries, WhatsApp orders) arrives as **requests** that wait for approval in the ERP; the cloud never writes business data.
   8. **No secrets online, no open ports.** The shop server is never reachable from the internet. Service keys are kept encrypted on the server with the master key, never in the repository, logs or plain text in the database.
   9. **Costs visible.** System health shows each feature's monthly use and estimated cost.
3. **WhatsApp moves from P4 to stage 2B.** P4 keeps email sending, promotions, loyalty, the multi-warehouse screens and the standby server.

## Why

- The owner wants AI and online help without risking the shop's daily work, its data or its VAT.
- The rules keep the golden rules true: money, stock and VAT stay in the ERP, decided by people, audited, and working offline.
- Writing the rules once means every stage plan is checked against the same list.

## How it works

- Each stage plan shows, rule by rule, how it keeps the nine rules, with tests for rules 2, 4, 5 and 7.
- **Inbound needs the relay.** WhatsApp delivers message statuses and customer messages to a public web address (webhooks), and the shop server never has one (rule 8). So:
  - delivery status and the customer assistant (2B) need the relay's receiving part;
  - the server collects what arrived by calling out to the relay, never the other way round.

  The relay is therefore built, at least its receiving part, before those 2B features (see the plan's dependencies).
- The gaps between today's design and the track are listed in the plan. They are not fixed now: each one is closed in the stage that needs it.

## Consequences

- No AI or online feature can block a sale, a payment or a shift close.
- Some features cost money every month (AI use, WhatsApp messages, hosting). The owner approves each budget, and System health shows the spending.
- The phone dashboard and the technician app read and write through the relay only, so the shop network stays closed (0093).
