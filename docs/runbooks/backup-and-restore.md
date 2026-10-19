# النسخ الاحتياطي والاسترجاع — دليل التشغيل

> **Backup and restore runbook** (decision [0086](../decisions/0086-backups-local-and-google-drive.md), M6.1).
> For the owner. The steps use the button names as they appear in the app in Arabic and English.
> The last section (a real restore) is for whoever restores the system after a disaster; it will be
> rehearsed on the real server PC with the installer (M6.2).

## إيه اللي بيحصل لوحده

برنامج النسخ (خدمة منفصلة على جهاز الكاشير/السيرفر) بيعمل الآتي من غير ما تعمل حاجة:

| إيه | إمتى | فين |
|---|---|---|
| نسخة كاملة من قاعدة البيانات | **كل ساعة** | فولدر النسخ على الجهاز (هارد تاني لو موجود). بيفضل آخر 48 ساعة + أول نسخة من كل يوم لآخر 30 يوم |
| نسخة **مشفّرة** | **كل يوم** | حساب Google Drive المخصص. بيفضل أول نسخة من كل يوم لآخر 30 يوم + من كل شهر لآخر 12 شهر. القديم بيروح سلة المهملات (جوجل بيسيبه فيها 30 يوم) |
| فحص السلامة | **كل ليلة بعد الساعة 2** | سجل المراقبة، القيود، المخزون، الترقيم |
| تنبيه | لو نسخة اتأخرت أو فشلت، أو تجربة الاسترجاع أو نسخة الهارد جه وقتها | شاشة **صحة النظام** + لوحة التحكم |

كل ده متسجّل في **الإعدادات ← النسخ الاحتياطي** (Settings → Backup)، وده للمالك بس.

## 1) أول مرة: مفتاح النسخ

1. **الإعدادات ← النسخ الاحتياطي ← «إنشاء مفتاح النسخ»** (Create backup key).
2. اقرا الشرح ودوس **«إنشاء مفتاح النسخ»**.
3. المفتاح الخاص هيظهر **مرة واحدة بس** (بيبدأ بـ `AGE-SECRET-KEY-1…`):
   - دوس **«اطبع»** واحتفظ بالورقة؛
   - ودوس **«احفظ في ملف»** واحفظ الملف على **فلاشة**.
4. اكتب **آخر 6 حروف** في المفتاح ودوس **«أنا احتفظت بالمفتاح»**.
   - ✅ يظهر «مفتاح النسخ اتظبط».
5. خلّي الورقة والفلاشة في **مكانين آمنين** بعيد عن جهاز الكاشير (مثلًا خزنة المكتب والبيت).

> ⚠️ لو المفتاح ضاع، النسخ اللي على Google Drive **مش هتتفتح أبدًا**. ساعتها اعمل مفتاح جديد
> (النسخ الجاية بس هتتشفّر بيه)، واحتفظ بالقديم لو لقيته.

## 2) أول مرة: حساب Google المخصص

### أ) الحساب
1. اعمل حساب Google **جديد مخصص للنسخ بس** (مثلًا `artepool.backups@gmail.com`).
2. فعّل عليه **التحقق بخطوتين** (Google Account → Security → 2-Step Verification).

### ب) «عميل Google» للبرنامج (مرة واحدة)
وإنت داخل بالحساب المخصص:
1. افتح <https://console.cloud.google.com> واعمل مشروع جديد باسم `ARTEPOOL Backups`.
2. **APIs & Services → Library**: دوّر على **Google Drive API** ودوس **Enable**.
3. **APIs & Services → OAuth consent screen**: اختار **External**، اكتب اسم التطبيق `ARTEPOOL Backups` وبريد الحساب، واحفظ. في **Test users** ضيف بريد الحساب المخصص نفسه. بعدها دوس **Publish app** عشان الربط ميخلصش بعد 7 أيام.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**، واختار النوع **TVs and Limited Input devices**، والاسم `ARTEPOOL backup service`.
5. انسخ **Client ID** و **Client secret**.

### ج) الربط في البرنامج
1. **الإعدادات ← النسخ الاحتياطي ← «ربط Google Drive»**.
2. الصق **Client ID** و **Client secret** ودوس **«التالي»**.
3. هيظهر **كود قصير**. افتح **google.com/device** من موبايلك أو أي جهاز، ادخل **بالحساب المخصص**، واكتب الكود، ووافق.
   - ✅ الشاشة تقول «Google Drive اتربط».
4. البرنامج بياخد صلاحية **ملفاته بس** (`drive.file`): ميقدرش يشوف أي ملف تاني على الحساب.
5. جرّب **«ارفع الآن»**، واستنى دقيقة، وافتح Google Drive من الموبايل:
   - ✅ تلاقي ملف اسمه زي `artepool-20261019-100000Z.dump.age`؛
   - ✅ لو حاولت تفتحه، مش هيتقري (مشفّر).

لفك الربط: **«فك الربط»** في نفس الشاشة. ولو الحساب نفسه اتسرق: غيّر كلمة سره، ومن
<https://myaccount.google.com/permissions> شيل صلاحية `ARTEPOOL Backups`، وبعدين اربط تاني.

## 3) كل أسبوع: الهارد الخارجي

1. ركّب الهارد الخارجي في **جهاز الكاشير/السيرفر**، وشوف حرفه في ويندوز (مثلًا `E:`).
2. **الإعدادات ← النسخ الاحتياطي ← الهارد الخارجي**: اكتب `E:\` في «فولدر الهارد» ودوس **«انسخ على الهارد»**.
3. استنى لما الطلب يبقى **«تم»** في «آخر الطلبات».
   - ✅ على الهارد فولدر `ARTEPOOL-BACKUPS` فيه آخر 8 نسخ وملف `README.txt`.
4. افصل الهارد وخلّيه في **مكان مقفول**. النسخ دي **مش مشفّرة** (اختيارك): أي حد يمسك الهارد يقدر يقراها.

## 4) كل شهر: تجربة الاسترجاع

1. **الإعدادات ← النسخ الاحتياطي ← «تجربة الاسترجاع» ← «ابدأ التجربة»**.
2. البرنامج بيرجّع آخر نسخة في قاعدة بيانات تجريبية منفصلة، ويفحصها، ويمسحها. البيانات الحقيقية مش بتتلمس.
3. بعد دقائق:
   - ✅ «تجربة الاسترجاع» عليها تاريخ النهارده، و«آخر فحص سلامة» كله أخضر؛
   - ❌ لو فشلت: متمسحش أي حاجة، وكلّم المسؤول الفني وابعتله الرسالة اللي ظاهرة.

## 5) لو ظهر تنبيه

| التنبيه | تعمل إيه |
|---|---|
| النسخة المحلية متأخرة | برنامج النسخ ممكن يكون واقف: اعمل Restart للجهاز. لو فضل، كلّم المسؤول الفني |
| آخر نسخة محلية فشلت | شوف الرسالة في «آخر الطلبات» أو جرّب «نسخة الآن» |
| النسخة الخارجية متأخرة / الرفع فشل | راجع الإنترنت. لو الرسالة فيها `invalid_grant`، اربط Google Drive تاني |
| هارد النسخ قرب يتملي | فضّي مساحة أو ركّب هارد أكبر للنسخ |
| فحص السلامة لقى مشكلة | **متصلّحش حاجة بإيدك**: صوّر الشاشة وكلّم المسؤول الفني |

## 6) أوامر الطوارئ (على جهاز السيرفر بس)

| الأمر | بيعمل إيه |
|---|---|
| `pnpm backup:once` | نسخة محلية دلوقتي |
| `pnpm backup:restore-test` | تجربة الاسترجاع وطباعة نتيجة كل فحص |
| `pnpm backup:check` | فحص السلامة على البيانات الحقيقية |
| `pnpm backup:offline E:\` | نسخة على الهارد الخارجي |
| `pnpm backup:run` | تشغيل برنامج النسخ (بيتشغّل كخدمة ويندوز من M6.2) |

## 7) Real restore after a disaster (technical)

To be rehearsed on the real server PC with the installer (M6.2); until then this is the procedure.

1. **Install** the server on the replacement PC (M6.2 installer). Do not run the setup wizard.
2. **Pick the copy:** the newest file from the local backup folder, the external drive
   (`ARTEPOOL-BACKUPS\artepool-…Z.dump`), or Google Drive (`artepool-…Z.dump.age`).
3. **Decrypt** a Google Drive copy with the owner's private key and the standard `age` tool
   (<https://github.com/FiloSottile/age/releases>):
   ```
   age --decrypt --identity artepool-backup-key.txt artepool-20261019-100000Z.dump.age > artepool.dump
   ```
4. **Stop** the API and backup services. As the PostgreSQL superuser, create the empty database
   owned by `artepool_owner` (the installer's roles must exist), then restore:
   ```
   pg_restore --host=localhost --username=postgres --dbname=artepool --exit-on-error artepool.dump
   ```
5. **Check** before opening the shop: `pnpm backup:check` must report every check OK, and
   `pnpm audit:verify` must report the audit chain intact. The audit chain head recorded with the
   copy (System health, or `audit.anchors` kind `backup`) must match.
6. **Start** the services; sign in as the owner; make a new local backup and a restore test.
7. Re-create the backup key if the old private key is lost, and reconnect Google Drive if the
   sealed credentials were not restored (`.secrets` is never inside a database copy).
