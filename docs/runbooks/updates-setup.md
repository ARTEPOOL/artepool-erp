# التحديثات الأوتوماتيك: اللي صاحب المحل بيعمله مرة واحدة

التحديثات بتنزل لوحدها من الإنترنت، وبتتسطّب على جهاز السيرفر في وقت آمن (مفيش وردية مفتوحة، بعد نسخة احتياطية اتأكدنا منها، بالليل أو لما تدوس **ثبّت دلوقتي**). بعدين أجهزة المكتب بتتحدّث. القرار: [0108](../decisions/0108-automatic-online-updates.md).

الكود بيفضل في المستودع الخاص. المستودع العام `ARTEPOOL/artepool-releases` فيه **ملفات التسطيب الموقّعة وقايمة التحديثات بس**. مفيش أي حاجة تانية بتتنشر هناك: فيه فحص بيوقف النشر لو لقى أي ملف غير المسموح بيه.

> كل خطوة هنا بتتعمل **مرة واحدة بس**. بعد كده، كل اللي عليك إنك توافق على كل تحديث بضغطة زرار واحدة.

## 1. التحقق بخطوتين على حساب GitHub (ضروري)

ده اللي بيحمي مفتاح التحديثات: محدش يقدر ينشر تحديث غير بموافقتك من حسابك.

1. ادخل على github.com بحسابك.
2. الصورة بتاعتك فوق على اليمين ← **Settings** ← **Password and authentication**.
3. **Enable two-factor authentication** ← اختار **Authenticator app** وامسح الكود بتطبيق الموبايل (نفس تطبيق آرتيبول، مثلًا Google Authenticator).
4. احفظ **Recovery codes** على ورقة في مكان أمين (مش على الكمبيوتر).

## 2. المستودع العام الفاضي

1. فوق على اليمين **+** ← **New repository**.
2. **Owner**: `ARTEPOOL` (المنظّمة)، **Repository name**: `artepool-releases`.
3. اختار **Public**، وعلّم على **Add a README file** (لازم: GitHub مش بيقبل أول تحديث في مستودع فاضي خالص). سيب باقي الاختيارات زي ما هي.
4. **Create repository**. خلاص، ما تحطش فيه أي حاجة تانية: الـ workflow هو اللي بيحط فيه ملفات التحديث.

> لو عملته من غير README: افتح المستودع ← **Add a README** ← **Commit changes**.

## 3. مفتاح التحديثات (مع الفني أو معايا)

المفتاح ده هو اللي بيثبت إن التحديث جاي منك. أي ملف مش موقّع بيه، جهاز السيرفر والبرنامج بيرفضوه.

1. على جهاز التطوير (اللي متسطّب عليه المشروع)، الفني يكتب مرة واحدة:
   ```
   pnpm release keygen
   ```
2. هيعمل فولدر اسمه **ARTEPOOL-update-key** في فولدر المستخدم، جواه ملفين:
   - `TAURI_SIGNING_PRIVATE_KEY.txt`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD.txt`
3. وهيكتب **المفتاح العام** في الملف `release/update-public-key.txt` في المشروع. المفتاح العام **مش سر**: الفني يرفعه (commit) أو يبعتلي محتواه وأنا أرفعه.
4. انسخ الفولدر **ARTEPOOL-update-key** على فلاشة، واحفظها في مكان أمين، وبعدين امسح الفولدر من الكمبيوتر بعد ما تعمل الخطوة 5.

> لو المفتاح ضاع أو حد شافه: كلّمني. هنعمل مفتاح جديد، والتحديث اللي بعده هيتسطّب مرة واحدة بالفلاشة.

## 4. التوكن بتاع النشر (صلاحيته على المستودع العام بس)

1. الصورة بتاعتك ← **Settings** ← تحت خالص **Developer settings** ← **Personal access tokens** ← **Fine-grained tokens** ← **Generate new token**.
2. **Token name**: `artepool-releases publish`.
3. **Expiration**: سنة (GitHub هيبعتلك إيميل قبل ما يخلص، وساعتها تعمل واحد جديد بنفس الخطوات).
4. **Resource owner**: `ARTEPOOL` (المنظّمة).
   - لو `ARTEPOOL` مش ظاهرة في القايمة: افتح المنظّمة ← **Settings** ← **Personal access tokens** ← **Settings** ← علّم **Allow access via fine-grained personal access tokens** ← **Save**، وارجع للخطوة دي.
   - لو المنظّمة طالبة موافقة على التوكن بعد ما تعمله: وافق عليه من **ARTEPOOL ← Settings ← Personal access tokens ← Pending requests**.
5. **Repository access** ← **Only select repositories** ← اختار `artepool-releases` **بس**.
6. **Permissions** ← **Repository permissions** ← **Contents** ← **Read and write**. سيب كل الباقي **No access**.
7. **Generate token** وانسخه (بيظهر مرة واحدة).

## 5. بيئة الموافقة "release" والأسرار

1. افتح المستودع الخاص `ARTEPOOL/artepool-erp` ← **Settings** ← **Environments** ← **New environment** ← الاسم: `release` ← **Configure environment**.
2. علّم **Required reviewers** واكتب اسم حسابك. (سيب **Prevent self-review** من غير علامة، علشان انت اللي بتوافق.)
3. **Deployment branches and tags** ← **Selected branches and tags** ← **Add deployment branch or tag rule** ← اختار **Tag** واكتب `v*`.
4. تحت **Environment secrets** ← **Add environment secret**، 3 مرات:

   | الاسم (Name) | القيمة (Value) |
   |---|---|
   | `TAURI_SIGNING_PRIVATE_KEY` | محتوى الملف `TAURI_SIGNING_PRIVATE_KEY.txt` كله |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | محتوى الملف `TAURI_SIGNING_PRIVATE_KEY_PASSWORD.txt` |
   | `RELEASES_TOKEN` | التوكن اللي عملته في الخطوة 4 |

5. **Save**. الأسرار دي محدش بيقدر يشوفها تاني، ولا حتى انت: GitHub بيستخدمها بس جوه البيئة دي بعد موافقتك.

## كل تحديث بعد كده: ضغطة واحدة

1. أنا بجهّز النسخة الجديدة وملاحظاتها بالعربي والإنجليزي، وبعد الدمج بعمل لها رقم (مثلًا `v0.2.0`).
2. هيجيلك إيميل من GitHub: **Review pending deployments**.
3. افتحه ← **Review deployments** ← علّم على **release** ← **Approve and deploy**.
4. GitHub بيبني وبيوقّع وبينشر. جهاز السيرفر هيلاقي التحديث لوحده خلال كام ساعة، ويسطّبه بالليل (أو دوس **ثبّت دلوقتي** من **الإعدادات ← صحة النظام والنسخ الاحتياطي ← التحديثات**).

## لو مفيش إنترنت

كل حاجة شغالة عادي. التحديث بيستنى لحد ما النت يرجع. في صحة النظام هتلاقي "مفيش إنترنت دلوقتي".

## نسخة الفلاشة (للدعم الفني بس)

لو حصلت مشكلة ومفيش إنترنت خالص: الدعم الفني يشغّل ملف **ARTEPOOL-Server-Setup** الأحدث على جهاز السيرفر (Run as administrator). بيعمل نفس التحديث الآمن بالظبط: نسخة احتياطية الأول، ولو أي حاجة فشلت النسخة القديمة بترجع.
