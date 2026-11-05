# M7 — Acceptance tools (PRD §12–13; phase plan M7, §6.3, §6.4; decision 0119)

| | |
|---|---|
| **Status** | **Approved by the owner (2026-11-05) with one change: no manual rehearsal sales; the rehearsal is fully automated** ([0119](../decisions/0119-automated-rehearsal-and-clean-go-live.md)). Building, in this order: A → B + C → D → E (F alongside). |
| **Scope** | The tools for the last step before go-live: the automatic reconciliation report, the automated rehearsal on the shop's server PC and the busy day in CI, the speed measurements, the guided hardware check, the export and the go-live guide, the security review. |
| **Not in scope** | The accountant's review and sign-off (0018): it runs in parallel and go-live still waits for it. |

## بالعربي، في سطور

- **الهدف:** قبل الافتتاح، **بروفة أوتوماتيك بالكامل** على جهاز السيرفر بتاع المحل. مفيش ولا بيعة بالإيد. في الآخر البرنامج بيراجع لوحده إن كل حاجة مطابقة بالظبط:
  - المخزون والكاش والفواتير؛
  - الضريبة والحسابات؛
  - سجل المراقبة والنسخة الاحتياطية.

  لو كله أخضر، وفحص الأجهزة تمام، والمحاسب وافق، نفتتح.
- **قاعدة بيانات نضيفة للافتتاح:**
  - الفاتورة ما بتتمسحش وأرقامها متسلسلة. علشان كده البروفة بتشتغل على **قاعدة بيانات بروفة منفصلة** بتتمسح بعدها، وبياناتك ما بتتلمسش.
  - التجارب اللي إنت عملتها لحد دلوقتي على الجهاز بتتشال يوم الافتتاح، والأصناف والعملاء والموردين بيتنقلوا بـ Excel.
  - رصيد المخزون الافتتاحي وأرصدة العملاء الافتتاحية بتتدخل يوم الافتتاح، وإنت بس اللي تدخلها.
- **الأجزاء بالترتيب:**
  1. **(أ) تقرير المطابقة:**
     - 7 مراجعات، كل واحدة أخضر أو أحمر، والأرقام جنب بعض، ولينك للمستند اللي فيه مشكلة؛
     - بيتطبع PDF للمحاسب، وبتشوفه إنت والمحاسب؛
     - والمراجعات دي بتشتغل لوحدها كل ليلة بعد الافتتاح.
  2. **(ب) البروفة الأوتوماتيك:**
     - زرار **«ابدأ البروفة»** في «صحة النظام»، ليك إنت بس؛
     - البرنامج بيعمل قاعدة بيانات بروفة على جهاز السيرفر، ويشغّل عليها يوم كامل لوحده: بيع كاشير، وفواتير A4، وتحصيل، ومرتجعات وإشعارات دائنة، وخصومات، وبيع بالسالب بموافقة، وفتح وقفل ورديات بالعدّ، وإدخال وإخراج كاش، وطباعة ملصقات، وكل الحالات؛
     - في الآخر بيطلع تقرير المطابقة أخضر أو أحمر، ويمسح قاعدة البروفة؛
     - وفي نفس الوقت، **اليوم المزدحم** على GitHub (4 كاشيرات، أكتر من 800 بيعة) بيشتغل كل ليلة.
  3. **(ج) السرعة:**
     - البروفة بتقيس السرعة على جهاز المحل نفسه؛
     - و«صحة النظام» فيها سطر سرعة على طول: «السرعة: البحث 0.1 ث · البيع 0.4 ث».
  4. **(د) فحص الأجهزة**، الخطوة الوحيدة اللي بالإيد، 5 دقايق:
     - إيصال تجربة، فتح الدرج، ملصق تجربة، وتمسح باركود الملصق ده نفسه؛
     - إنت بس بتدوس «تمام» أو «فيه مشكلة».
  5. **(هـ) التصدير ودليل الافتتاح:**
     - تصدير الأصناف والعملاء والموردين لـ Excel بنفس شكل ملف الاستيراد؛
     - ودليل الافتتاح خطوة بخطوة.
  6. **(و) مراجعة الأمان:** مكتوبة، وأي مشكلة تتصلح.

### المميزات
- مفيش يوم شغل ضايع منك ومن الكاشير. دوسة زرار، وحوالي ربع ساعة، والنتيجة قدامك.
- البروفة بتشتغل على جهاز المحل الحقيقي، بنفس البرنامج اللي هيشتغل يوم الافتتاح.
- تقدر تعيد البروفة في أي وقت، مثلًا بعد أي تحديث كبير، من غير ما تلمس بياناتك.
- اليوم المزدحم على GitHub بيحمي كل تعديل جاي.
- المراجعات بتفضل شغالة كل ليلة بعد الافتتاح.

### العيوب
- البروفة ما بتسوقش شاشات اللابتوب نفسها. ده محتاج تحكم عن بعد، والمحل ما بيسمحش بيه (0093). شغل المكتب (A4 والتحصيل) بيتعمل في البروفة كأنه جهاز مكتب، بنفس كود السيرفر، واللابتوب نفسه ليه خطوة اختيارية في فحص الأجهزة (طباعة صفحة A4).
- الورق والدرج والماسح والطابعات الحقيقية مش بتتجرب في البروفة نفسها. ده شغل فحص الأجهزة.
- البروفة بتاخد من جهاز السيرفر حوالي ربع ساعة، فمش بتشتغل وفيه وردية مفتوحة.
- الافتتاح محتاج إعداد جديد مرة واحدة، حوالي ساعة لساعتين.

---

## 1. Why a clean database at go-live

- Posted documents are immutable and never deleted (golden rules 2–3), and every series is gapless (rule 5).
- **The rehearsal never touches the live database.** It runs in its own throwaway database, which is dropped at the end.
- The documents made **while testing** on the shop PC are in the live database, though. So go-live starts from a **new database**:
  1. the items, customers and suppliers are exported to Excel;
  2. the data is deleted with the existing *delete data* step (owner's password + DELETE, 0103);
  3. the first-run wizard runs again;
  4. the files are imported.
- **Opening stock** (0042) and **customer opening balances** (0051) are entered on go-live day, by the owner only.
- The test period's backups are kept (0103). The guide says how to tell them apart: they are dated before go-live.

## 2. Part A — The reconciliation checks and report

### New checks
They are added to the existing integrity checks (`apps/backup/src/integrity.ts`), so they also run:
- every night;
- after every database start;
- in every restore test;
- in every rehearsal.

Each check returns a count and a few ids, never personal data.

| Check | Rule |
|---|---|
| `cash_shifts` | For every closed shift: counted cash = expected cash + the recorded variance. Every variance above the threshold is accepted (0058). At most one recount, approved (0006). |
| `document_totals` | Every issued sales document: totals = Σ lines (net, VAT, total); invoice VAT = Σ line VAT. Each line: price × quantity − discount = net, and net + VAT = total, through the shared rounding helper. |
| `invoice_formats` | Full tax invoice ⇔ the customer was VAT-registered at issue (TRN on the document) (0010/0071). `POS-` only on POS sales, `INV-` only on A4 (0011). |
| `vat_ledger` | Σ output VAT of issued documents (credit notes subtract, debit notes add) = the movement on the account mapped as *VAT payable*, read from `gl.account_mappings`. Advance VAT is counted once: a final invoice's deductions take back the advance VAT (0013). |
| `postings` | Every issued document, payment, cash movement and stock adjustment is posted exactly once. Every reversal has its reversing entry. A manual entry on a control account is flagged. |
| `receivables` | The receivables control account = Σ customer balances. The customer advances account = Σ advance payment invoices not yet deducted. |
| `oversells` | The report needs every oversell reviewed. The nightly run only warns on one pending for more than 7 days. |
| `z_anchors` | Every Z report's chain anchor is in the audit chain at its sequence, with the same hash. |

The existing checks stay:
- the audit chain;
- journals balanced;
- the trial balance;
- stock = Σ movements;
- gapless series;
- settlements (0113).

### The report
**Reports → «تقرير المطابقة» / "Reconciliation":**
- *Who:* the owner and the accountant (new permission `reports.reconciliation`; owner, 2026-11-05).
- *Period:* from–to, today by default.
- *Content:* the seven steps of §6.3, each green or red, with the figures side by side and links to the documents with a problem:
  1. stock;
  2. cash;
  3. invoices;
  4. VAT;
  5. accounts;
  6. audit;
  7. backup (the last restore test).
- *Print / PDF:* A4, Arabic and English.
- *Records:* every run is kept (`ops.integrity_runs`, kind `reconciliation`) and audited.
- *Amounts:* follow the existing permissions (0040, 0114).

**Tests:**
- every check is broken on purpose in a throwaway database and must be caught;
- the report's permissions;
- the screens in Arabic and English, light and dark.

## 3. Part B — The automated rehearsal (one engine, two uses)

**One scripted rehearsal engine** in the server package, `apps/server/src/rehearsal/`, is used in two ways:

| | Shop rehearsal | Busy day (CI) |
|---|---|---|
| Started by | **«ابدأ البروفة»** on System health (owner only, new owner-only permission `system.rehearsal`) | `pnpm acceptance:day`, every night in GitHub Actions, before every release, and on demand |
| Where | The shop's server PC, its real PostgreSQL and programs | A GitHub runner |
| Size | Every case, on 2 tills and an office PC (about 150 POS sales), ~10–20 minutes | 4 tills at once, 800+ POS sales, 20,000 items |
| Result | Green/red on screen, kept for the owner and the accountant | The run fails on red; a table in the run summary |

### What the script does
1. **Its own database.** It creates `artepool_rehearsal_<run>`, writes a marker with a random token, and runs every migration. A throwaway master key is kept in memory only. **It can only drop a database with that prefix and its own marker.** It never writes to the live database, except the run's progress and result row.
2. **Seed data:**
   - items (unit and kg/m, bundles, every VAT category, barcodes);
   - customers: walk-in, cash, credit, VAT-registered with address;
   - users: owner, accountant, supervisor, cashiers, each with 2-step;
   - the tills (POS PCs) and an office PC, **enrolled through the normal enrollment flow**.
3. **The day, through the server's real API code** (the same routes, permission checks, approvals with the supervisor's one-time codes, idempotency, audit), tills working at the same time:
   - **shifts:** opening floats, then shift close with blind counts, one approved recount, and the Z report;
   - **POS sales:** cash, card, split; discounts within and above the limit (with approval); cart removals; oversell with approval and its review; a POS return with a credit note and the refund;
   - **A4 work:** a quotation → an advance payment invoice → a progress payment → the final invoice with deductions, for a VAT-registered customer; an unpaid invoice for a credit customer;
   - **receipts:** oldest first, an advance;
   - **cheques:** a bounced cheque (`RVS-`);
   - **cash:** paid in and paid out, a cash drop, an X report;
   - **stock:** an adjustment, a count with variances;
   - **labels:** print jobs recorded, with no printer;
   - **printing:** every document type rendered to PDF by the real renderer, checked for its required fields.
4. **Then:**
   - every check of part A;
   - a backup of the rehearsal database → restore → the checks again on the restored copy;
   - the speed figures (part C).
5. **The end:** the result (each step ✓/✗, the seven-step report, the speed) is written to the live database, and the rehearsal database is dropped. A rehearsal database left behind by a crash is dropped at the next run.

### On the shop's server PC
- **The button** writes a request row in a new table, `ops.rehearsal_runs` (audited). It is refused:
  - while a shift is open;
  - while an update is installing;
  - while another rehearsal runs;
  - with less than 2 GB of free disk.
- **The updater** (SYSTEM, already every minute, and woken at once like "Install now") starts `artepool-svc run rehearsal <run>` as a separate process, at low priority. It connects with the backup role (CREATEDB, as the restore test does) and the migrator.
- **The screen** shows the progress step by step, then the result. The report prints for the accountant (`reports.reconciliation`).
- **The laptop:** the script plays the office PC through the same API. Driving the laptop's own screens would need remote control, which the shop doesn't allow (0093). The laptop gets an optional step in the hardware check instead.

## 4. Part C — Speed

**In the rehearsal and the busy day:**
- item search and barcode scan: 95% of requests under **300 ms**;
- sale completion with the tills at once: 95% under **2 s** (PRD §12).

The busy day measures with 20,000 items and fails above the target. The shop rehearsal shows the figures from the real server PC.

**On System health, permanently** (owner, 2026-11-05):
- The server times its own search, scan and sale requests. It keeps only the last 1,000 durations of each kind in memory: no content, nothing written to disk.
- One line: **«السرعة: البحث 0.08 ث · البيع 0.4 ث (95%)»**, coloured as a warning above the target.

## 5. Part D — The guided hardware check (the only human step)

**Where and who:** System health → **«فحص الأجهزة» / "Hardware check"**, on the POS PC, for the owner. About 5 minutes; each step has **«تمام»** and **«فيه مشكلة»** (with an optional note):
1. **Test receipt** on this PC's receipt printer.
2. **Open the drawer.**
3. **Test label** on the label printer.
4. **Scan the barcode** printed on that test label. The app also checks that the scanned code matches.
5. *(Optional, on the laptop)* print an A4 test page through the print dialog.

**Records:** the result is kept (`ops.hardware_checks`, audited) and shown beside the last rehearsal.

**Ready for go-live** means:
- the last rehearsal is green;
- the hardware check is all «تمام»;
- the accountant has signed off.

## 6. Part E — The export and the go-live guide

**The export.** Items → **«تصدير إلى Excel»**, and the same for suppliers:
- *Who:* `data.export`, the same permission as the customers export.
- *Format:* the import template's columns, so the file goes straight back in. For items, that means code, type, Arabic/English names, category, unit, VAT category, sale price, includes-VAT, purchase price (only for those allowed to see it, 0038), barcode, reorder level, for sale, line of business, descriptions.
- *More than one barcode:* an item with several barcodes gets one row per extra barcode, if the import accepts that; otherwise the import gains it.
- *Logging:* every export is an audit event.
- *Check:* the customers export is checked against its import template.
- *Test:* export → import into an empty database → the same items, customers and suppliers.

**The guide:** `docs/runbooks/go-live.md`, in Arabic, step by step:
1. Export the items, customers and suppliers.
2. Uninstall with "delete data".
3. Install.
4. New setup: company, owner, 2-step (remove the old entry in the phone app first), new recovery codes.
5. The cashier account (emergency tool).
6. The receipt printer.
7. Google Drive.
8. Users.
9. Enroll the laptop again.
10. The print design.
11. Import items, customers and suppliers.
12. **Opening stock** (owner only, 0042).
13. **Customer opening balances** (owner only, 0051).
14. The first real sale.

## 7. Part F — Security review and changelog

**The review:** `docs/reviews/m7-security-review.md`. It covers:
- the permission matrix against every route;
- database privileges;
- TLS and the CA;
- secrets;
- update signing;
- logs;
- backup encryption;
- the emergency tools;
- the kiosk lock and the cashier account;
- the rehearsal's own database rules.

**Findings:** each one is fixed in its own small commit, or listed for the owner.

**Also:**
- `pnpm deps:check` clean;
- `docs/CHANGELOG.md` gets a Phase 1 summary.

## 8. Order and versions

**Order** (owner, 2026-11-05):
1. A, the reconciliation report.
2. B + C, the automated rehearsal, the busy day and the speed line.
3. D, the hardware check.
4. E, the export and the go-live guide.
5. F, alongside.

**Release:** version 0.10.0 when A–E are done.

**Before the rehearsal:** the blank credit-note print was fixed in 0.9.3, with a test of every document type. That test now also checks every required (locked) field of each document's template.
