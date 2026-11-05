# M7 — Acceptance tools (PRD §12–13; phase plan M7, §6.3, §6.4)

| | |
|---|---|
| **Status** | **Proposed (2026-11-05), waiting for the owner's approval.** No code before the approval. |
| **Scope** | The tools for the last step before go-live: the automatic reconciliation, a simulated busy day, the speed measurements, the rehearsal day on the shop PCs, the move from the rehearsal to real data, the security review. |
| **Not in scope** | The accountant's review and sign-off (0018): it runs in parallel and go-live still waits for it. |

## بالعربي، في سطور

- **الهدف:** قبل الافتتاح نعمل **«يوم بروفة»** على أجهزة المحل الحقيقية. في آخر اليوم البرنامج يراجع لوحده إن كل حاجة مطابقة بالظبط: المخزون، الكاش، الفواتير، الضريبة، الحسابات، سجل المراقبة، والنسخة الاحتياطية. لو كله أخضر نفتتح.
- **حاجة مهمة لازم تعرفها:** الفاتورة في البرنامج عمرها ما بتتمسح، وأرقامها متسلسلة من غير فراغات. عشان كده أي حاجة بتتعمل دلوقتي على جهاز المحل (تجاربك ويوم البروفة) بتعتبر **تجربة**. قبل الافتتاح بنبدأ **بقاعدة بيانات نضيفة**. الأصناف والعملاء بيتنقلوا عن طريق Excel، فمش هتكتبهم تاني.
- **الخطة 6 أجزاء:**
  1. **(أ) تقرير المطابقة:** شاشة واحدة في التقارير فيها 7 مراجعات، كل واحدة أخضر أو أحمر، والأرقام جنب بعض. مثال: «الضريبة في الفواتير 1,234.56 = حساب الضريبة المستحقة 1,234.56». ولو فيه مشكلة، لينك للمستند اللي فيه المشكلة. ويتطبع PDF للمحاسب. والمراجعات دي كمان **بتشتغل لوحدها كل ليلة** بعد الافتتاح، ولو حاجة اختلفت «صحة النظام» بتنبهك.
  2. **(ب) يوم مزدحم أوتوماتيك:** برنامج بيعمل نسخة تجريبية فاضية ويشغّل عليها يوم كامل: 4 كاشيرات بيبيعوا في نفس الوقت، أكتر من 800 بيعة، ومعاهم كل الحالات (خصومات، مرتجعات، دفعات مقدمة، شيك مرتجع، جرد، قفل ورديات). في الآخر بيعمل تقرير المطابقة، ولو حاجة غلط بيفشل. بيشتغل على GitHub كل ليلة، ويحمي البرنامج من أي غلطة في أي تعديل جاي، زي المشتريات وغيرها.
  3. **(ج) السرعة:** نفس البرنامج بيقيس البحث والباركود مع 20,000 صنف (المطلوب أقل من ثلث ثانية)، والبيع مع 4 كاشيرات مع بعض (المطلوب أقل من ثانيتين). وعلى جهاز المحل نفسه، السيرفر بيقيس سرعته طول الوقت، و«صحة النظام» بتعرض سطر واحد: «السرعة: البحث 0.1 ث، البيع 0.4 ث».
  4. **(د) يوم البروفة:** ورقة خطوات بالعربي تتطبع: مين يعمل إيه، على أي جهاز، وإيه المفروض يحصل، وجنب كل خطوة مربع ✓. جهاز الكاشير بيبيع، واللابتوب بيعمل فواتير A4 وتحصيل في نفس الوقت. بنستخدم الطابعة والدرج والماسح وطابعة الملصقات الحقيقية.
  5. **(هـ) من البروفة للافتتاح:**
     - زرار جديد **«تصدير الأصناف»** (والموردين) لملف Excel بنفس شكل ملف الاستيراد (تصدير العملاء موجود أصلًا)؛
     - ودليل بالعربي خطوة بخطوة: تصدير، مسح بيانات التجربة، تثبيت جديد، إعداد، استيراد، رصيد افتتاحي، أول بيعة حقيقية.
  6. **(و) مراجعة الأمان وسجل التغييرات:** أنا بعمل مراجعة أمان مكتوبة لكل حاجة (الصلاحيات، قاعدة البيانات، التشفير، المفاتيح، التحديثات، السجلات)، وأي مشكلة بتتصلح في تعديل صغير لوحده.

### المميزات
- تقرير واحد يقولك «كله مطابق» أو يوريك المشكلة فين بالظبط.
- المراجعات بتفضل شغالة كل ليلة بعد الافتتاح، مش بس يوم البروفة.
- اليوم المزدحم الأوتوماتيك بيحمي أي تعديل جاي (المشتريات، المصروفات، الفاتورة الإلكترونية) من إنه يبوّظ الحسابات من غير ما نحس.
- السرعة بتتقاس على جهاز المحل الحقيقي، مش بس على GitHub.
- الافتتاح من غير ما تكتب الأصناف والعملاء من الأول.

### العيوب
- يوم البروفة محتاج يوم شغل منك ومن الكاشير.
- الافتتاح محتاج إعداد جديد مرة واحدة، حوالي ساعة لساعتين: الـ 2-step من جديد، وتسجيل اللابتوب تاني، وحساب الكاشير، وجوجل درايف، والمستخدمين، وتصميم الطباعة. تصميم الطباعة مش بيتنقل لوحده في الخطة دي.
- اليوم المزدحم الأوتوماتيك بيشتغل على لينكس في GitHub، مش ويندوز. حاجات ويندوز (الطابعة، الدرج، حساب الكاشير) بيغطيها اختبار ويندوز الأوتوماتيك ويوم البروفة.

### أسئلة محتاج ردك عليها
1. **عدد البيعات اليدوية في يوم البروفة:**
   - (أ) **اقتراحي:** حوالي 80 بيعة بالإيد تغطي كل الحالات، والزحمة (أكتر من 800 بيعة على 4 كاشيرات) يثبتها اليوم الأوتوماتيك.
   - (ب) أكتر من 200 بيعة بالإيد زي ما مكتوب في الـ PRD دلوقتي.
2. **الافتتاح من قاعدة بيانات نضيفة**، وبيانات التجربة تتمسح بعد تصدير الأصناف والعملاء: موافق؟ مفيش طريقة تانية تحترم قاعدة «ما فيش مسح للفواتير».
3. **تقرير المطابقة يشوفه مين:** إنت والمحاسب (اقتراحي)، ولا إنت بس؟
4. **سطر السرعة في «صحة النظام»** يفضل على طول (اقتراحي) ولا يوم البروفة بس؟

---

## 1. Why a clean database at go-live

- Posted documents are immutable and never deleted (golden rules 2–3), and every series is gapless (rule 5).
- Every sale made while testing or on the rehearsal day is a real, numbered tax document in that database. Go-live therefore starts from a **new database**: the rehearsal installation's data is deleted with the existing *delete data* step (owner's password + DELETE, 0103), and the shop starts again with the first-run wizard.
- Master data typed during testing is carried over by Excel. The customers export exists; part E adds the items export in the import template's format.
- The rehearsal's backups are kept, like every backup (0103). The go-live guide says how to tell them apart: they are dated before the go-live day.

## 2. Part A — The reconciliation checks and report

### New checks
They are added to the existing integrity checks (`apps/backup/src/integrity.ts`), so they also run:
- every night;
- after every database start;
- in every restore test.

System health already alerts on a failed check. Each check returns a count and a few ids, never personal data (as today).

| Check | Rule |
|---|---|
| `cash_shifts` | For every closed shift: counted cash = expected cash + the recorded variance. Every variance above the threshold is accepted (0058). At most one recount, approved (0006). |
| `document_totals` | Every issued sales document: totals = Σ lines (net, VAT, total); invoice VAT = Σ line VAT; each line: price × quantity − discount = net, and net + VAT = total, through the shared rounding helper. |
| `invoice_formats` | Full tax invoice ⇔ the customer was VAT-registered at issue (TRN on the document) (0010/0071). `POS-` only on POS sales, `INV-` only on A4 (0011). |
| `vat_ledger` | Σ output VAT of issued documents (credit notes subtract, debit notes add) = the movement on the account mapped as *VAT payable*. The account is read from `gl.account_mappings`, never a hard-coded 2130. Advance VAT is counted once: a final invoice's deductions take back the advance VAT (0013). |
| `postings` | Every issued document, payment, cash movement and stock adjustment is posted exactly once. Every reversal has its reversing entry. A manual entry on a control account (receivables, VAT payable, customer advances, inventory) is flagged. |
| `receivables` | The receivables control account = Σ customer balances (the statements). The customer advances account = Σ advance payment invoices not yet deducted. |
| `oversells` | The report needs every oversell reviewed. The nightly run only warns on one pending for more than 7 days. |
| `z_anchors` | Every Z report's chain anchor is in the audit chain at its sequence, with the same hash. |

The existing checks stay as they are:
- the audit chain;
- journals balanced;
- the trial balance;
- stock = Σ movements;
- gapless series;
- settlements (0113).

### The report
- **Where and who:** Reports → **«تقرير المطابقة» / "Reconciliation"**, for the owner and the accountant (new permission `reports.reconciliation`; question 3).
- **Period:** from–to, today by default.
- **Content:** the seven steps of §6.3, each green or red, in this order:
  1. stock;
  2. cash;
  3. invoices;
  4. VAT;
  5. accounts;
  6. audit;
  7. backup.
- **Figures:** each step shows the figures side by side and links to the documents with a problem.
- **Step 7 (backup):** shows the last restore test (date and result), with a link to System health → "Restore test".
- **Print / PDF:** A4, Arabic and English, for the accountant.
- **Records:** every run is kept (`ops.integrity_runs`, new kind `reconciliation`) and audited. Amounts follow the existing permissions: cost only with `stock.view_cost` (0040), balances only with `customers.balance.view` (0114).

### Tests
- Every check is broken on purpose in a throwaway database and must be caught, as the existing integrity tests do.
- Permission tests for the report.
- Screen tests in Arabic and English, light and dark.

## 3. Part B — The simulated busy day (automatic, in CI)

`pnpm acceptance:day`:

1. **Its own database only.** It creates its own throwaway database and refuses any other: the name must start with `artepool_accept_`, and the database must carry the marker this run wrote. It can never touch the shop's data.
2. **Seed data:**
   - 20,000 items (unit and kg/m, bundles, every VAT category);
   - customers: walk-in, cash, credit, VAT-registered with address;
   - users: owner, accountant, supervisor, four cashiers;
   - four POS PCs with their drawers and opening floats.
3. **A full day through the server's real API code**, with the four tills selling at the same time:
   - **POS sales:** 800+ (cash, card, split; discounts within and above the 5% limit with approval codes; cart removals);
   - **oversells:** 2 with approval, then their review;
   - **returns:** to sellable and to defective;
   - **A4 work** for a VAT-registered customer: a quotation → an advance payment invoice → a progress payment → the final invoice with deductions;
   - **cash and cheques:** a refund, a bounced cheque, paid in/out, a cash drop, an X report;
   - **stock:** a count with variances;
   - **closing:** shift closes with one recount, and the Z reports.
4. **Checks:** every check of part A, then a backup → restore → the checks again on the restored copy (PRD §13: "a backup is restored successfully").
5. **Fails if any check fails.** The result is a table in the GitHub run summary.

**When it runs:** every night in GitHub Actions, before every release, and on demand.

## 4. Part C — Speed

### In the simulated day
It measures, with 20,000 items:
- item search and barcode scan: 95% of requests under **300 ms**;
- sale completion with four tills at once: 95% under **2 s** (PRD §12).

The table is in the run summary, and the run fails above the target.

### On the real server PC
- The server times its own search, scan and sale requests all the time. It keeps only the last 1,000 durations of each kind in memory: no content, nothing written to disk.
- System health shows one line: **«السرعة: البحث 0.08 ث · البيع 0.4 ث (95%)»**, coloured as a warning above the target (question 4).
- So the rehearsal day measures the real hardware, and a slowdown after go-live is seen.

## 5. Part D — The rehearsal day on the shop PCs (people)

**The guide:** `docs/runbooks/rehearsal-day.md`, in Arabic, to print.

**People and PCs:**
- the owner and the cashier (and the accountant if available);
- the POS PC is the till; the laptop is the second terminal at the same time (A4 invoices, receipts, the count review, reports).

**About 40 numbered actions,** each with what must happen and a ✓ box:
- opening float;
- sales with cash, card and split, and discounts within and above the limit;
- a cart removal;
- two oversells with approval;
- a return to sellable and one to defective;
- a quotation → an advance → a progress payment → the final invoice for a VAT-registered customer;
- a refund, a bounced cheque, paid in/out, a cash drop, an X report;
- labels;
- a count with variances;
- shift close with one recount, and Z.

**The real hardware:** receipt printer, drawer, scanner, label printer.

**At the end:**
- the reconciliation report, all green;
- a restore test;
- the report printed for the accountant.

**Number of hand sales:** question 1.

## 6. Part E — From the rehearsal to go-live

**The items export.** Items → **«تصدير إلى Excel»**:
- *Who:* `data.export`, the same permission as the customers export.
- *Format:* the import template's columns, so the file goes straight back in. That means code, type, Arabic/English names, category, unit, VAT category, sale price, includes-VAT, purchase price (only for those allowed to see it, 0038), barcode, reorder level, for sale, line of business, descriptions.
- *More than one barcode:* an item with several barcodes gets one row per extra barcode, if the import accepts that; otherwise the import gains it.
- *Suppliers:* the same export, for the suppliers.
- *Logging:* every export is logged as an audit event (as the customers export).
- *Check:* the customers export is checked against its import template and fixed if a column differs.
- *Test:* export → import into an empty database → the same items, customers and suppliers.

**The guide:** `docs/runbooks/go-live.md`, in Arabic, step by step:
1. Export the items, customers and suppliers.
2. Uninstall with "delete data".
3. Install.
4. New setup: company, owner, 2-step. Remove the old entry in the phone app first; new recovery codes.
5. The cashier account (emergency tool).
6. The receipt printer.
7. Google Drive.
8. Users.
9. Enroll the laptop again.
10. The print design.
11. Import items and customers.
12. Opening stock (0042).
13. Customer opening balances (0051).
14. The first real sale.

## 7. Part F — Security review and changelog

**The review:** `docs/reviews/m7-security-review.md`. It covers:
- the permission matrix against every route (the meta-test exists);
- database privileges;
- TLS and the CA;
- secrets handling;
- update signing;
- logs (no secrets);
- backup encryption;
- the emergency tools;
- the kiosk lock and the cashier account.

**Findings:** each one is fixed in its own small commit, or listed for the owner when it needs a decision.

**Also:**
- `pnpm deps:check` clean;
- `docs/CHANGELOG.md` gets a Phase 1 summary.

## 8. Order, versions and what stays open

**Order:**
1. A (checks, then the report).
2. B and C.
3. E.
4. The D guide.
5. F.

**Release:** version 0.10.0 when A, B, C and E are done, so the rehearsal can run on the shop PCs.

**Timing:**
- The rehearsal can run before the accountant's answers.
- If the accountant changes accounts or the posting map, a new migration changes the defaults, and the nightly simulated day checks them again.
- Go-live waits for the accountant's sign-off (0018) and the owner's ✓ on the rehearsal day.

**After the answers:**
- question 1 may change PRD §6.3 ("200+ POS sales");
- question 3 decides the report's permission.
