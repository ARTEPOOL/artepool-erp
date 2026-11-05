# The VAT period archive — automatic PDFs per tax period (decision 0119)

| | |
|---|---|
| **Status** | **Proposed (2026-11-05), waiting for the owner's approval** (four questions below). No code before the approval. VAT points pending accountant review. |
| **Decisions** | [0119](../decisions/0119-vat-period-archive.md) (this feature), [0017](../decisions/0017-quarterly-vat-export-and-annual-archive.md) (the P2 export package; its sales half comes earlier), [0071](../decisions/0071-a4-invoices-full-and-reprints-current-design.md) (reprints; question 1), [0086](../decisions/0086-backups-local-and-google-drive.md) (backups), [0085](../decisions/0085-server-on-the-pos-pc.md) (folder protection) |
| **Size** | About 1.5–2 weeks of work. |

## بالعربي، في سطور

- **الهدف:** البرنامج يجهّز لوحده **فولدر لكل فترة ضريبية** (3 شهور زي ما مكتوبة في EmaraTax). كل فاتورة أو إشعار بيتحفظ جواه PDF أول ما يطلع. وفي آخر الفترة بيتكتب **ملخص الضريبة** (PDF وExcel)، والأرقام مترتبة على خانات إقرار VAT201. المحاسب ياخد الفترة جاهزة، وأي طلب من الهيئة الفولدر يبقى جاهز.
- **الإعداد:**
  - في الإعدادات ← الضريبة والترقيم: «شهر بداية الفترة الضريبية» (زي EmaraTax)، و«كل 3 شهور» أو «كل شهر».
  - إنت بس اللي تغيّره، بسبب، ومتسجّل.
  - التغيير بيبدأ من فترة جاية، وعمره ما بيحرّك فولدرات قديمة.
- **الفولدر:**
  - اسمه زي `VAT 01-09-2026 TO 30-11-2026`.
  - جواه `POS` و`A4` و`Credit notes` و`Debit notes`. فواتير الدفعات المقدمة بتروح في A4.
  - اسم الملف: `POS-000123 - 05-09-2026.pdf`.
  - تاريخ المستند هو اللي بيحدد فترته، بتوقيت دبي.
- **عمرها ما توقّف بيعة:**
  - الـ PDF بيتعمل في الخلفية بعد البيعة بثواني.
  - لو حصلت مشكلة، بيحاول تاني لوحده.
  - «صحة النظام» بتقولك لو فيه ملفات ناقصة، وفيه زرار «اعملها تاني».
- **في آخر الفترة** (بعد نص الليل بتوقيت دبي): **ملخص الضريبة** PDF وExcel، وفيه:
  - إجمالي كل نوع مستند؛
  - الصافي والضريبة لكل فئة ضريبية؛
  - الإشعارات الدائنة مخصومة؛
  - الأرقام على خانات VAT201 (خانة 1a أبوظبي بتاعتنا)؛
  - قايمة أرقام المستندات، متراجعة إن مفيش فيها فراغات.
- **مكانه:**
  - على جهاز السيرفر في فولدر البيانات المحمي. الكاشير ما يقدرش يمسح ولا يغيّر.
  - بيتنسخ مع النسخ الاحتياطية: جوجل درايف متشفّر، والهارد الخارجي.
- **إنت والمحاسب:** شاشة **«أرشيف الضريبة»** في البرنامج، من أي جهاز حتى اللابتوب. تفتح أي ملف، أو تعمل **«تصدير الفترة»** ZIP على فلاشة.
- **محدش يقدر يلعب في الملفات من غير ما تعرف:**
  - كل ملف ليه بصمة.
  - كل ليلة البرنامج بيتأكد إن الملفات موجودة وما اتغيرتش.
  - لو ملف اتمسح أو اتغيّر بيعمله تاني بالظبط، لأن بيانات المستند وتصميم الطباعة بتاعه محفوظين في قاعدة البيانات.

### المميزات
- المحاسب ياخد الفترة كاملة في دقيقة، من غير ما حد يطبع أو يجمّع حاجة.
- أي طلب من الهيئة: الفولدر جاهز ومترتب.
- مستحيل ملف يضيع أو يتغيّر من غير ما تعرف، ومستحيل فاتورة تفوت من التسلسل.
- الأرقام على خانات VAT201 جاهزة، ومتراجعة على حساب الضريبة في الدفاتر.

### العيوب
- **المساحة:** الفاتورة حوالي 90 كيلو. لو 50 مستند في اليوم، يبقى حوالي 400 ميجا كل 3 شهور (حوالي 1.6 جيجا في السنة)، على الجهاز وعلى جوجل درايف. مع السنين ممكن جوجل درايف يحتاج مساحة أكبر (اشتراك Google One صغير).
- عمل الـ PDF بياخد شوية من جهاز السيرفر في الخلفية، زي طباعة A4 بالظبط، ملف ورا ملف.
- خانات ضريبة المشتريات (من 9 لـ 11) فاضية لحد المرحلة التانية (المشتريات). المحاسب بيكملها من فواتير المشتريات لحد ما ده يتعمل.

### أسئلة محتاج ردك عليها
1. **إعادة الطباعة.** القرار 0071 بيقول إن إعادة الطباعة بتستخدم **تصميم النهارده**، وإنت طالب إن ملف الأرشيف يطابق أي إعادة طباعة بالظبط. لازم نختار:
   - (أ) **اقتراحي:** إعادة الطباعة تستخدم **تصميم يوم الإصدار**، فأي إعادة طباعة تبقى نفس ملف الأرشيف بالظبط (ما عدا كلمة «نسخة» لو مفعّلة). العيب: لو غيّرت التصميم بعدين، الفواتير القديمة تفضل بالشكل القديم.
   - (ب) نسيب 0071 زي ما هو: الأرشيف بالشكل الأصلي، وإعادة الطباعة بالتصميم الجديد. المحتوى واحد، والشكل ممكن يختلف.
2. **فواتير الكاشير (POS) في الأرشيف:**
   - (أ) **اقتراحي:** بشكل A4، نفس «إعادة طباعة A4» الموجودة، وفيها كل البيانات الضريبية.
   - (ب) بشكل الإيصال الحراري (عرض 8 سم). ده محتاج رسّام جديد على السيرفر، وممكن يطلع فيه فروق صغيرة عن الإيصال المطبوع.
3. **الكاشير والفولدر:**
   - (أ) **اقتراحي:** مقفول تمامًا على الكاشير (ما يفتحش ولا يقرا)، زي فولدر النسخ الاحتياطية، لأن فيه أسامي العملاء وأرقامهم الضريبية. إنت والمحاسب بتفتحوه من شاشة الأرشيف.
   - (ب) الكاشير يقدر يقرا بس، زي ما كتبت.
4. **التوقيت:**
   - (أ) **اقتراحي:** أبنيه بعد تقرير المطابقة (الجزء أ من M7) وقبل يوم البروفة. كده يتجرب في البروفة ويشتغل من أول يوم افتتاح.
   - (ب) بعد الافتتاح. الملفات ممكن تتعمل بأثر رجعي، لأن كل حاجة محفوظة.

### أسئلة للمحاسب (هبني بالاختيار المقترح لحد ما يرد)
- أي تاريخ بيحدد الفترة: **تاريخ الإصدار** (اللي الدفاتر والتقارير بتستخدمه، اقتراحي)، ولا تاريخ التوريد لو كان أقدم؟
- الإشعارات الدائنة في VAT201: بتتخصم من مبلغ وضريبة خانة 1a في فترة الإشعار (اقتراحي)، ولا تتكتب في عمود «التعديلات»؟
- مدة الحفظ القانونية (غالبًا 5 سنين بعد نهاية الفترة). إحنا أصلًا عمرنا ما بنمسح.

---

## 1. The setting and the periods

**Settings** (Settings → VAT & numbering), owner only (new owner-only permission `vat.period.edit`), with a reason, audited (`sys.settings` is audited):
- `vat.period_start_month`: 1–12, as shown in EmaraTax / the VAT certificate;
- `vat.period_months`: 3 (default) or 1;
- `vat.period_effective_from`: the first day of the first period these values apply to.

They replace the `vat.quarter_start_month` planned in 0017.

**A change** applies from a period that has no archived document yet (the current one if it is still empty, otherwise the next one). Folders already made never move.

**One shared, pure function** (`packages/shared`), with property tests: `vatPeriodOf(date, settings)` → `{ start, end }`. Every date is in exactly one period, and the periods follow each other with no gap or overlap. Staggered quarters such as Dec–Feb cross the year.

**Not set yet:** documents are still queued (nothing is lost). An alert and the System health line say "Set the VAT tax period in Settings → VAT & numbering". Once it is set, the queue runs.

**The period of a document** is decided by its **issue date** (server time, Asia/Dubai), the same date the journals and the owner dashboard use. Whether an earlier date of supply should decide it instead is a question for the accountant.

## 2. What is archived

| Document | Series | Subfolder |
|---|---|---|
| POS sale (simplified or full tax invoice) | `POS-` | `POS` |
| A4 invoice | `INV-` | `A4` |
| Advance / progress payment tax invoice | `INV-` | `A4` |
| Credit note | `CN-` | `Credit notes` |
| Debit note | `DN-` | `Debit notes` |

- **File name:** `<number> - DD-MM-YYYY.pdf`, e.g. `POS-000123 - 05-09-2026.pdf`.
- **Folder:** `VAT DD-MM-YYYY TO DD-MM-YYYY`, made with the period's first document.
- **Not archived:** receipts, refunds, payment reversals (`RVS-`), quotations. They are not tax documents. An advance's bounced cheque still produces its credit note, which is archived.

## 3. How a PDF is made

1. **Queued in the same transaction.** When a sales document becomes *issued*, a database trigger adds a row to a new table `ops.vat_archive_files` in the same transaction (golden rule 4). A crash can never lose one.
   - The row holds: document, period, subfolder, file name, status (`pending` / `done` / `failed`), attempts, next attempt, last error, the design version used, SHA-256, size, time written.
   - A second table, `ops.vat_periods`, holds: period start/end, folder name, summary state and the summary files' SHA-256.
   - Both tables get touch/stamp, audit and no-delete, with explicit grants.
2. **A background worker in the API service** takes one pending row at a time, with a short pause between files so the POS stays fast. It renders the A4 PDF with the existing renderer:
   - from the document's stored data and **its stored design version**: the A4 design in force when it was issued, kept in the design history;
   - with no "Copy" mark;
   - without counting as a print (`print_count` unchanged, not logged as a reprint).
3. **Written safely:** to a temporary file first, then renamed into place, then its SHA-256 recorded. A finished file is never overwritten, except by **Regenerate** when it is missing or changed.
4. **Retries:** after 1 minute, rising to every hour. A failing row shows on System health. **A sale is never blocked or slowed by this.**

## 4. The period end: the VAT summary

**When:** after 00:00 Asia/Dubai on the day after the period's last day, once every PDF of the period is done. No document can be dated in a past period (server time only), so the summary is final.

**Files:**
- `VAT summary DD-MM-YYYY TO DD-MM-YYYY.pdf` (bilingual, the A4 design);
- `VAT summary DD-MM-YYYY TO DD-MM-YYYY.xlsx`.

**Content:**
1. **Per document type:** count, net, VAT, total.
2. **Per VAT category** (standard 5%, zero-rated, exempt, out of scope): net and VAT.
3. **Credit notes and debit notes,** shown and deducted.
4. **VAT201 boxes:**
   - **Box 1** in the row of the company's emirate, read from the company profile (Abu Dhabi → **1a**), never hard-coded;
   - box 4 zero-rated, box 5 exempt, box 8 totals;
   - boxes 9–11 (input VAT): "from purchases — Phase 2";
   - boxes 12–14 worked out with input VAT 0 and marked provisional.

   Out-of-scope supplies are not reported. The box mapping is data, pending accountant review.
5. **The numbers, per series:** first, last, count, and **no gaps**, both inside the period and from the previous period's last number.
6. **Cross-check:** the summary's VAT = the movement on the account mapped as *VAT payable* in the period (the M7 check `vat_ledger`).

**"Summary so far":** can be seen in the app at any time, marked provisional. It is written to the folder only after the period ends.

## 5. Where the files live and who can reach them

**On disk:** `C:\ProgramData\ARTEPOOL\vat-archive\VAT …\…`. Rules on the folder:
- SYSTEM and Administrators: full control;
- the API service: modify;
- the backup service: read;
- **standard Windows accounts, the cashier's included: nothing** (question 3; they can never delete or change a file).

The install and upgrade create the folder and its rules. *Delete data* (go-live from the rehearsal, M7) removes it with the rest of the data.

**In the app:** Accounting → **«أرشيف الضريبة» / "VAT archive"**, for the owner and the accountant (new permission `vat.archive`):
- the periods with their counts and state;
- the files as in the folder;
- open or save a PDF;
- **"Export period (ZIP)"** → the save dialog, to any folder or a USB stick;
- **"Regenerate missing"**.

It works on every enrolled PC, the laptop included, because the files go through the API (golden rule 7: no PC opens the server's folders). On the server PC an administrator also reaches the folder directly. Exports and regenerations are audited (`vat_archive.exported`, `vat_archive.regenerated`). An exported ZIP is not encrypted, so the accountant can open it; the screen says it holds customer details.

## 6. System health and the nightly check

- **The line:** «أرشيف الضريبة: تمام» / «N ملف ناقص — اعملها تاني» / «الفترة الضريبية مش متحددة».
- **Nightly integrity check `vat_archive`:** every issued tax document has a done file, and every file is on disk with its recorded SHA-256. A moved, changed or deleted file counts as missing and can be regenerated.

## 7. Backups

1. **Google Drive:** the daily encrypted upload adds, as one small age-encrypted part, the PDFs written since the last upload (≈ 5 MB a day at 50 documents). At period end the summary files go up too. These parts are **never pruned**.
2. **External drive:** the weekly copy includes the whole archive folder (encrypted, as today).
3. **The database backups** (hourly local, daily Drive) already let every file be regenerated exactly, from the stored data and design versions.
4. **A restore** puts the folder back from the parts, or regenerates what is missing.

## 8. Relation to 0017 and Phase 2

- 0017's quarterly export package and annual archive stay in P2.
- This decision delivers its **sales half earlier**, into the same per-period folders.
- P2 adds the purchases with input VAT (boxes 9–11) and the annual file to the same folders and summary.

## 9. Tests

**Period maths (property tests):**
- staggered quarters (Sep–Nov, Oct–Dec, Dec–Feb across the year end), and monthly periods;
- 29 February;
- every date in exactly one period, and the periods follow each other.

**Dubai midnight:** a sale at 23:59:59 Dubai on a period's last day (19:59:59 UTC) and one at 00:00:00 the next day each land in the right folder.

**All five document types:** each in its subfolder with the right name; the advance payment invoice in `A4`.

**Numbering:** the list has no gaps, and a gap forced in a test database is reported.

**The same as a reprint:** the archived PDF equals a reprint, compared by text (pdftotext) and page images (pdftoppm), apart from the "Copy" word.

**Never blocks a sale:**
- with the renderer broken, the sale still succeeds and its row stays pending;
- the row is retried, System health shows it, and Regenerate fixes it.

**Files are protected:**
- a deleted or changed file is found by the nightly check and regenerated;
- the cashier cannot open or delete the files (Windows CI, like the M6.4 cashier probe).

**Permissions and audit:**
- only the owner and the accountant see and export;
- only the owner changes the setting;
- every write and export produces its audit entry.

**Screens:** Arabic and English, light and dark.
