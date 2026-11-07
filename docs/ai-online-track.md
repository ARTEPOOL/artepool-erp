# The AI & Online track (stages 2A–2D) — ARTÉPOOL ERP

| | |
|---|---|
| **Status** | **Approved idea list, staged plan** (owner, 2026-11-05; ground rules in [0118](decisions/0118-ai-online-ground-rules.md)). **No code until M7 is done and the shop is live.** Each stage starts only when the owner asks, with a detailed plan approved first. |
| **Order** | [0116](decisions/0116-order-after-go-live.md): after go-live, **P2 (money) first**, then this track interleaved with P3 (contracts, visits, service jobs, projects), as the owner decides. E-invoicing is ready before 1 July 2027 whatever else is going on. |
| **Name** | A separate track, not "Phase 2" (0116). The owner's draft was called "Phase 2 — AI and Online Extensions". |
| **Source** | The owner's draft `phase-2-ai-online.md` (2026-11-05). Sections 1–6 keep its content; sections 7–9 (gaps, effort and costs, privacy) were added at the owner's request. |

<div dir="rtl">

## ملخص للمالك

| المرحلة | الأفكار | المطلوب منك |
|---|---|---|
| **2أ: داخل البرنامج** | حاسبة كيماويات المسبح، منشورات السوشيال، مساعد المحاسب، البيع بالصوت | الموافقة على شركة الذكاء الاصطناعي والميزانية الشهرية |
| **2ب: واتساب** | واتساب بزنس (فواتير وتذكير)، موظف الواتساب الذكي | رقم موبايل مخصص للمحل + حساب Meta Business موثّق |
| **2ج: الجسر السحابي** | لوحة الموبايل، تطبيق فني الصيانة | اشتراك استضافة سحابية صغير |
| **2د: بعد جاهزية الموقع** | طلبات عروض الأسعار والصيانة من الموقع | الموقع شغال + المبرمج يربط الفورم |

**الترتيب:** M6 ← M7 ← التشغيل الفعلي ← المرحلة التانية (الفلوس: المشتريات والموردين والمصروفات وإقرار الضريبة) ← المسار ده (2أ ← 2ب ← 2ج ← 2د) بالتبادل مع المرحلة التالتة (العقود والزيارات والمشاريع)، باللي تختاره كل مرة. الفاتورة الإلكترونية جاهزة قبل 1 يوليو 2027.

**ملحوظة:** موظف الواتساب الذكي، وإن الفاتورة توصل للعميل ونعرف ده، محتاجين الجسر السحابي (2ج) أو جزء منه. السبب إن واتساب بيبعت الرسايل الجاية للمحل على عنوان على الإنترنت، وجهاز المحل مقفول من الإنترنت (وده صح).

**التكلفة الشهرية التقريبية** (حجم محل زي بتاعنا، أسعار نوفمبر 2026):
- 2أ: حوالي 30–50 درهم؛
- 2ب: حوالي 25–40 درهم رسايل، و10–30 للموظف الذكي؛
- 2ج: حوالي 50–60 درهم (سيرفر في الإمارات)؛
- 2د: مفيش زيادة.

المجموع حوالي 120–200 درهم في الشهر لو كله شغال. وكل ميزة ليها زرار إيقاف.

</div>

---

## 1. Ground rules (every feature) — decision [0118](decisions/0118-ai-online-ground-rules.md)

1. **Offline-first stays.** Sales, POS, accounting and stock never depend on the internet or on any AI service. If the internet is down, these features wait; the shop keeps working.
2. **AI only suggests.** Nothing that affects money, VAT, stock, prices, discounts, credit or customer commitments is committed without a human action in the app.
3. **Minimal personal data.** Send AI services only what the task needs; prefer IDs and summaries over names, phones, addresses and home photos. Follow UAE PDPL principles.
4. **Audited.** Every AI suggestion that is accepted or rejected, and every outbound message, is recorded in the audit log (who, when, what, from which device).
5. **Controllable.** Each feature has its own permission and an owner-only on/off switch in Settings.
6. **Outbox pattern.** Every outbound call (AI, WhatsApp, cloud relay) goes through a persistent outbox with retries and visible status; nothing is lost when offline.
7. **One-way cloud.** The cloud receives summaries pushed from the shop server. Inbound items (website requests, technician entries, WhatsApp orders) arrive as **requests** that wait for approval inside the ERP; the cloud never writes business data directly.
8. **No secrets online, no open ports.** The shop server is never exposed to the internet. API keys are stored encrypted on the server (master key), never in the repository, logs or the database in plain text.
9. **Costs visible.** Show monthly usage and estimated cost per feature on the System health screen.

---

## 2. Stage 2A — Inside the app (no new infrastructure)

### 1) Pool chemical dosing calculator
- **Inputs:**
  - the pool volume, or its dimensions → volume;
  - the water test values: free chlorine, pH, total alkalinity, calcium hardness, cyanuric acid, and optionally temperature.
- **Output:**
  - recommended products and quantities **from our own items** (by active ingredient and strength);
  - the dosing order step by step, with safety notes;
  - one click adds them to the POS cart or an A4 invoice/quotation for review.
- **How it works:**
  - the core maths runs **offline**, using documented formulas with unit tests;
  - AI (when online) only adds a plain-language explanation in Arabic/English.
- **Item data:** items need dosing metadata (active ingredient, concentration, unit), added as optional item fields.

### 2) Social posts from inventory
- **Start:** one click on an item, or the app's suggestions (slow movers, new arrivals, items with stock above target).
- **Draft:**
  - an Instagram/Facebook post in **Gulf Arabic** (English optional), with the price or offer and hashtags;
  - optional product photo enhancement (background clean-up).
- **Output:** a draft to copy or download. No automatic publishing in this stage.

### 3) Accountant assistant (before month close)
- **Checks and flags:**
  - invoices to VAT-registered customers missing a TRN;
  - unusual expenses compared with history;
  - unposted or draft documents;
  - receipts not allocated;
  - negative stock;
  - credit notes without a reason;
  - period items not reconciled.
- **Output:** suggestions only, each with a link to the document.
- **How it works:** mostly offline (rules); AI is optional, for explanations.

### 4) Voice selling at POS
- **What happens:** the cashier says the items and quantities (Arabic/English, Gulf or Egyptian phrasing); the cart is filled and highlighted for review before payment.
- **Matching:** against our item names, aliases and barcodes. An unclear item is asked about, never guessed silently.
- **Microphone:** push-to-talk only; no continuous listening; no audio stored.

**Owner prepares:** approve the AI provider and monthly budget.

---

## 3. Stage 2B — WhatsApp

### 5) WhatsApp Business
- **Documents:** send invoice / quotation / statement / receipt PDFs to the customer in one click, through the WhatsApp Business Platform (Cloud API) with approved templates.
- **Payment reminders:** automatic reminders for overdue invoices, **only for customers who opted in**; the owner sets the schedule and wording.
- **Delivery:** the status is shown on the document; everything goes through the outbox.

### 6) AI WhatsApp assistant for customers
- **Answers:** price and availability from **live stock**, opening hours, location, and general product guidance.
- **Requests:** if the customer wants to buy or needs a quotation, it creates an **order/quote request** that waits for staff approval.
- **Limits:**
  - never confirms an order, price, discount, delivery date or credit by itself;
  - hands over to a person on request or when unsure;
  - clearly tells the customer it is an automated assistant.
- **Connection:** reuses the WhatsApp connection from item 5.

**Owner prepares:** a dedicated shop mobile number not registered on regular WhatsApp; a verified Meta Business account (trade licence).

---

## 4. Stage 2C — Secure cloud relay

### 7) Owner mobile dashboard (read-only)
- **Shows:** today's sales against a comparison period, drawer cash, open shifts, over/short, overdue customers, low stock, alerts.
- **Builds the one-way relay:**
  - the shop server pushes summaries to a small cloud service;
  - the phone reads from the cloud;
  - the cloud has no path back into the shop.

### 8) Maintenance technician mobile app
- **Records:** a visit log per customer pool, the checklist, water test values, photos, chemicals and materials used.
- **Into the ERP:** entries arrive as **requests**; stock is deducted, and anything billable is created, only after approval.
- **Works offline:** on the phone, syncing when online. Reuses the relay.

**Owner prepares:** a small cloud hosting subscription.

---

## 5. Stage 2D — After the website is ready

### 9) Website quote and maintenance requests
- **The form:** on the ARTÉPOOL website (name, phone, area, request type, details, optional photos). It sends requests to the **cloud relay**, never directly to the shop server.
- **In the ERP:** requests appear as items waiting for approval; each can then become a customer, a quotation or a service job.
- **For the website developer:** an endpoint and an API key from us.
- **Protection:** spam protection and rate limits on the relay.

**Owner prepares:** the website live, and contact with its developer.

---

## 6. Dependencies (added)

| Feature | Needs first | Why |
|---|---|---|
| 1) Dosing calculator | — (works with a typed volume) | Linked to the customer's pool once P3 adds pool profiles. |
| 3) Accountant assistant | **P2** for "unusual expenses" | Expenses only exist from P2. The other checks work on P1 data. |
| 5) WhatsApp: delivery status | **The relay's receiving part** (2C) | WhatsApp reports statuses to a public web address (webhook); the shop server has none (rule 8). Sending alone works without it. |
| 6) WhatsApp assistant | **The relay's receiving part** (2C) | Customer messages also arrive by webhook. |
| 8) Technician app | **P3** (pool profiles, contracts, visits, technician stock) and the relay | It records visits that only exist from P3. |
| 9) Website requests | The relay (2C) | The form never talks to the shop. |

So the smallest workable order inside the track is:
1. 2A;
2. 2B sending (item 5 without delivery status);
3. the relay with the dashboard (2C item 7, including the webhook receiving part);
4. 2B delivery status and the assistant (item 6);
5. 2D;
6. the technician app once P3 visits exist.

---

## 7. Gaps in today's design (list only; nothing fixed now)

Each gap is closed in the stage that needs it, inside that stage's own plan.

| # | Gap | Today | Needed by |
|---|---|---|---|
| G1 | **A general outbox and its sender** | `ops.outbox` exists (channels `einvoice`, `email`, `whatsapp`), tied to a sales document. There is no sender process yet. | All. It also needs channels for AI and the relay, rows not tied to a sales document (a reminder, a summary), use/cost per row, retries with back-off, and a status screen. |
| G2 | **An inbound path** | None by design: no public address (0093). | 2B status/assistant, 2C, 2D. The relay receives; the shop server collects by calling out. |
| G3 | **An inbox of requests waiting for approval** | Supervisor approvals exist (one-time codes); there is no queue of outside requests. | 6, 8, 9. A request table (source, status new/accepted/rejected/converted, link to the customer/quotation/job made from it), a screen and permissions. |
| G4 | **A switch per feature** | Permissions (with owner-only) and audited settings exist; adding rows is a migration. | All. A Settings section with the owner-only switches. |
| G5 | **A record of AI suggestions** | The audit log keeps row changes and events. | 2A, 6. Per suggestion: feature, a summary of the input (no personal data), provider/model, use and cost, accepted or rejected, by whom; new event types. |
| G6 | **Service keys** | Sealing with the master key exists (the Google Drive token). | All. Reuse it for AI, WhatsApp and relay keys, plus an owner-only screen to enter or replace a key (never shown back). |
| G7 | **Use and cost on System health** | None. | All (rule 9). |
| G8 | **Item fields** | No dosing fields, no aliases, no product photo (only the company logo). | 1 (active ingredient, strength, form, dose unit); 4 and 6 (aliases: spoken and common names); 2 (a product photo, PNG/JPEG like the logo). |
| G9 | **Customer consent for WhatsApp** | Phone (required, unique) and preferred language exist. | 5, 6. An opt-in (date, how it was given, recorded by whom), an opt-out at any time, "reminders allowed". |
| G10 | **Microphone at the POS** | The app never uses the microphone. | 4. Push-to-talk in the Windows app (WebView2 permission), a visible "listening" state, nothing recorded. |
| G11 | **Internet status** | Only seen through Drive uploads and updates. | All. One System health line for the outbox and the internet. |
| G12 | **Pool data** | None in P1 (pool profiles are P3). | 1 (typed each time until P3), 8. |
| G13 | **Phone sign-in for the relay** | The ERP signs in PCs only (enrolled devices). | 7, 8. Its own sign-in on the relay (owner with 2-step; technicians), with nothing able to write into the shop. |

Already in place and reusable:
- server-rendered PDFs for every document and the statement (for WhatsApp);
- the invoice statuses and overdue dates (0113, for reminders);
- the owner dashboard figures (0081, for the phone);
- the audit log and its hash chain;
- the master key;
- the alerts.

---

## 8. Effort and monthly running cost per stage (rough)

**Effort** means build + tests + review, in working weeks; the owner's testing is extra. These are rough figures, refined in each stage's plan.

| Stage | Effort (rough) | Running cost per month (rough) | What drives the cost |
|---|---|---|---|
| **2A** | 5–7 weeks: shared AI base (G1, G4–G7) ~1; calculator 1–1.5; posts ~1; accountant assistant 1–1.5; voice selling 1.5–2 | **≈ AED 30–50** (AI ≈ AED 35–45 + speech-to-text < AED 5); + ≈ AED 75 if the photo clean-up service is used | AI use per request; speech-to-text per minute; photo clean-up per image |
| **2B** | Sending + reminders ~2 weeks; the assistant 2–3 weeks (after the relay's receiving part). Meta's business verification can take days to weeks, outside our control. | **≈ AED 25–40** for messages; + ≈ AED 10–30 AI for the assistant | WhatsApp's price per delivered template message (UAE rates); AI for the assistant |
| **2C** | Relay + phone dashboard 3–4 weeks; technician app 4–6 weeks (after P3) | **≈ AED 50–60** in a UAE region (recommended), or ≈ AED 22–30 in Europe | A small server and database in the cloud |
| **2D** | 1–2 weeks (after the relay) | ~0 extra | Uses the relay |

**All four stages together:** roughly **AED 120–200 a month** at this shop's size. Every feature has its own switch, so a feature that is off costs nothing.

### How the costs were estimated (prices checked 2026-11-05; USD × 3.6725)

Assumed shop size: 20–60 sales a day, a few hundred customers.

**AI (Claude API)**, per million tokens (input / output):
- Haiku 5.5: $0.10 / $0.50;
- Sonnet 5.5: $2 / $10;
- Opus 5.5: $4 / $20.

Batch runs are 50% off, and the repeated instructions can be cached.

Assumed use per month:
- 1,200 voice commands understood by Haiku;
- 600 explanations and accountant-assistant answers on Sonnet;
- 30 post drafts.

That is ≈ $9–12. Doing everything with the largest model would be ≈ AED 60–90.

Claude reads images but **not audio**, so voice selling needs a separate speech-to-text service.

**Speech-to-text**, per minute:
- OpenAI $0.003–0.006;
- Google $0.016 ($0.003 in batch);
- Azure $1 an hour real-time, with 5 free hours a month.

About 80 minutes a month costs under AED 5.

Running it on the PC (Whisper) is free and private, but a vendor's published comparison shows it still gets roughly half the words wrong in Gulf Arabic. So the cloud option is the realistic start, kept behind the switch.

**WhatsApp (Cloud API):**
- Billing is per delivered template message. UAE rates from 1 Oct 2026, from two resellers' copies of Meta's rate card (Meta's own card could not be opened):
  - utility (invoices, receipts, reminders): ≈ $0.0157 (AED 0.058);
  - marketing: ≈ $0.0576 (AED 0.21).
- **Changes since 1 Oct 2026:**
  - utility templates are charged even inside a customer's 24-hour window;
  - replies to customers are free up to 1,000 a month per number, then charged.
- Example: 300 invoices/receipts + 100 reminders ≈ AED 23–25 with VAT. A reminder with promotional wording counts as marketing, about four times the price.
- A reseller's (BSP) platform fee, if one is used, is extra.

**Cloud relay**, one small server:
- Azure UAE North (Dubai) ≈ $15 a month with disk and address;
- AWS UAE ≈ $7.5 + disk;
- Hetzner or DigitalOcean in Europe ≈ $6–7.

A UAE region costs about AED 30 more but keeps the data in the country (see section 9). Oracle's free tier exists, but it can reclaim a lightly used server, so it is not recommended for the relay.

**Photo clean-up:**
- Photoroom's API is ≈ $0.02 per image;
- remove.bg is ≈ $0.16–0.23 per image;
- the free local tool (rembg): its default model needs a paid licence for commercial use, so it would be checked first.

---

## 9. Privacy notes (UAE PDPL)

| Stage | What leaves the shop | How it is kept small |
|---|---|---|
| **2A — calculator** | Nothing personal: volume and water values. The explanation request carries only those. | — |
| **2A — posts** | Product data and product photos. | Never customers, never photos of homes. |
| **2A — accountant assistant** | Nothing for the rule checks (offline). The optional explanation sends document numbers and amounts. | No names, phones or TRNs. |
| **2A — voice selling** | The cashier's spoken words, sent to a speech-to-text service, unless it runs on the PC. | Push-to-talk, no audio kept, nothing else sent. The on-PC option sends nothing. |
| **2B — WhatsApp** | The customer's phone number and the document PDF go to Meta, on servers outside the UAE. | Only customers who agreed (consent recorded, opt-out honoured); approved templates; reminders within the owner's hours. |
| **2B — assistant** | The customer's messages go to the AI provider. | The customer is told it is automated. The first version answers prices, stock, hours and location only, never account or balance details, and never sends the customer's history. |
| **2C — dashboard** | Totals and alerts. | Customer names only where the owner needs them (overdue list); otherwise totals. Hosting in a UAE region, encrypted, owner sign-in with 2-step. |
| **2C — technician app** | Customer address, the visit, pool photos (homes). | Kept on the relay only until the ERP takes them in, then deleted (e.g. after 30 days). Only the technician's own visits on the phone. |
| **2D — website** | What the visitor types in the form. | Privacy notice and consent box on the website; spam limits; deleted from the relay once the ERP has it. |

**What the law says today (checked 2026-11-05; to be confirmed by the accountant or a lawyer):**
- **The PDPL** (Federal Decree-Law 45 of 2021) is in force, but its executive regulations still seem unpublished, and there is no list yet of countries approved for data transfers.
- **Sending personal data abroad** is allowed only with one of these:
  - a contract that binds the receiver to the same protection;
  - the person's express consent;
  - when the data is needed to perform a contract with that person.

  Meta (WhatsApp), an AI provider abroad and hosting in Europe all count as sending abroad. A UAE hosting region avoids that question for the relay.
- **Marketing messages** need consent (Cabinet Resolution 56/2024, fines up to AED 150,000 under 57/2024), and people can refuse direct marketing at any time.
- **WhatsApp's own rules:** Meta asks for a clear opt-in that names the business. A number already used on regular WhatsApp cannot be registered on the API until it is removed there.

**General:**
- one written list of what each provider receives;
- data kept in the UAE where a provider allows it;
- a way to answer a customer who asks what we hold about them;
- the accountant or a lawyer confirms the PDPL points before 2B goes live.
