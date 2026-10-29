# Provisional chart of accounts

**Status: pending accountant review** ([decision 0018](../decisions/0018-chart-of-accounts-and-posting-map.md)). This chart is seeded in Phase 1 so development and testing can run. It must be approved, or changed, before go-live.

All accounts, names and mappings are **data in the system**, not code. The accountant can add, rename or remap accounts without any programming. Header accounts (marked **H**) group other accounts and cannot receive postings.

| Code | Account (English) | الحساب (Arabic) | Type | System use |
|---|---|---|---|---|
| **1000** | **Assets** H | **الأصول** | Asset | |
| 1100 | Cash and bank H | النقد والبنوك | Asset | |
| 1110 | Cash on hand – POS drawers | النقد في أدراج نقاط البيع | Asset | Cash payment method |
| 1120 | Cash in safe | النقد في الخزنة | Asset | Cash drops / float |
| 1130 | Petty cash | العهدة النقدية | Asset | |
| 1140 | Bank – current account | البنك – الحساب الجاري | Asset | Bank transfer method |
| 1150 | Card settlements receivable | مستحقات تسويات البطاقات | Asset | Card payment method |
| 1160 | Cheques in hand | شيكات تحت التحصيل | Asset | Cheque payment method |
| 1200 | Receivables H | الذمم المدينة | Asset | |
| 1210 | Accounts receivable – customers *(control)* | ذمم العملاء | Asset | Every customer posting |
| 1220 | Employee advances | سلف الموظفين | Asset | |
| 1230 | Other receivables | ذمم مدينة أخرى | Asset | |
| 1300 | Inventory H | المخزون | Asset | |
| 1310 | Inventory – sellable | المخزون – صالح للبيع | Asset | Stock (available) |
| 1320 | Inventory – defective | المخزون – تالف | Asset | Defective returns (0015) |
| 1400 | Other current assets H | أصول متداولة أخرى | Asset | |
| 1410 | VAT recoverable (input VAT) | ضريبة القيمة المضافة المستردة | Asset | Purchases/expenses (P2) |
| 1420 | Prepaid expenses | مصروفات مدفوعة مقدماً | Asset | |
| 1430 | Supplier advances | دفعات مقدمة للموردين | Asset | (P2) |
| 1440 | Deposits paid | تأمينات مدفوعة | Asset | |
| 1500 | Fixed assets H | الأصول الثابتة | Asset | |
| 1510 | Vehicles | المركبات | Asset | |
| 1520 | Tools and equipment | العدد والمعدات | Asset | |
| 1530 | Furniture and office equipment | الأثاث والمعدات المكتبية | Asset | |
| 1540 | Computers and IT equipment | أجهزة الحاسوب وتقنية المعلومات | Asset | |
| 1590 | Accumulated depreciation | مجمع الإهلاك | Asset (contra) | |
| **2000** | **Liabilities** H | **الالتزامات** | Liability | |
| 2100 | Current liabilities H | الالتزامات المتداولة | Liability | |
| 2110 | Accounts payable – suppliers *(control)* | ذمم الموردين | Liability | (P2) |
| 2120 | Customer advances | دفعات مقدمة من العملاء | Liability | Advance/progress payment invoices (0013) |
| 2130 | VAT payable (output VAT) | ضريبة القيمة المضافة المستحقة | Liability | Every tax document |
| 2140 | Accrued expenses | مصروفات مستحقة | Liability | |
| 2150 | Salaries payable | رواتب مستحقة | Liability | |
| 2200 | Non-current liabilities H | الالتزامات غير المتداولة | Liability | |
| 2210 | End-of-service benefits provision | مخصص مكافأة نهاية الخدمة | Liability | |
| 2220 | Loans | القروض | Liability | |
| **3000** | **Equity** H | **حقوق الملكية** | Equity | |
| 3100 | Owners' capital | رأس مال الشركاء | Equity | |
| 3200 | Owners' current accounts / drawings | الحسابات الجارية للشركاء | Equity | |
| 3300 | Retained earnings | الأرباح المحتجزة | Equity | |
| 3900 | Opening balance equity *(temporary)* | حقوق ملكية الأرصدة الافتتاحية | Equity | Go-live opening balances |
| **4000** | **Revenue** H | **الإيرادات** | Revenue | |
| 4100 | Revenue – pool supplies | إيرادات – مستلزمات المسابح | Revenue | Line of business: supplies |
| 4200 | Revenue – pool construction | إيرادات – إنشاء المسابح | Revenue | Line of business: construction |
| 4300 | Revenue – pool maintenance | إيرادات – صيانة المسابح | Revenue | Line of business: maintenance |
| 4400 | Revenue – pool cleaning | إيرادات – تنظيف المسابح | Revenue | Line of business: cleaning |
| 4900 | Other income | إيرادات أخرى | Revenue | |
| **5000** | **Cost of sales** H | **تكلفة المبيعات** | Expense | |
| 5100 | Cost of sales – pool supplies | تكلفة المبيعات – مستلزمات المسابح | Expense | Supplies cost |
| 5200 | Cost of sales – pool construction | تكلفة المبيعات – إنشاء المسابح | Expense | Construction cost |
| 5300 | Cost of sales – pool maintenance | تكلفة المبيعات – صيانة المسابح | Expense | Maintenance cost |
| 5400 | Cost of sales – pool cleaning | تكلفة المبيعات – تنظيف المسابح | Expense | Cleaning cost |
| 5600 | Inventory adjustments (gains and losses) | تسويات المخزون | Expense | Counts, adjustments, oversell |
| 5700 | Defective stock write-offs | شطب المخزون التالف | Expense | Write-offs (0015) |
| **6000** | **Operating expenses** H | **المصروفات التشغيلية** | Expense | |
| 6100 | Salaries and wages | الرواتب والأجور | Expense | |
| 6110 | Visas, labour and staff fees | رسوم التأشيرات والعمالة | Expense | |
| 6120 | End-of-service benefits expense | مصروف مكافأة نهاية الخدمة | Expense | |
| 6200 | Rent | الإيجار | Expense | |
| 6210 | Electricity and water | الكهرباء والماء | Expense | |
| 6220 | Telephone and internet | الهاتف والإنترنت | Expense | |
| 6300 | Vehicle fuel | وقود المركبات | Expense | |
| 6310 | Vehicle maintenance and registration | صيانة وترخيص المركبات | Expense | |
| 6400 | Repairs and maintenance | الإصلاحات والصيانة | Expense | |
| 6500 | Office supplies and printing | القرطاسية والطباعة | Expense | |
| 6510 | Marketing and advertising | التسويق والإعلان | Expense | |
| 6600 | Bank charges | الرسوم البنكية | Expense | |
| 6610 | Card merchant fees | عمولات البطاقات | Expense | |
| 6700 | Government fees and trade licence | الرسوم الحكومية والرخصة التجارية | Expense | |
| 6710 | Insurance | التأمين | Expense | |
| 6720 | Professional fees | الأتعاب المهنية | Expense | |
| 6800 | Depreciation | الإهلاك | Expense | |
| 6900 | Petty cash expenses (general) | مصروفات نثرية | Expense | Default for POS paid-outs |
| 6910 | Cash over / short | عجز وزيادة النقدية | Expense | Shift variances |
| 6990 | Miscellaneous expenses | مصروفات متنوعة | Expense | |

## Questions for the accountant
1. Are the account codes and names acceptable? Any accounts to add, merge or rename?
2. Revenue and cost of sales by line of business (4100–4400 / 5100–5400): is that the right level of detail?
3. Should inventory gains and losses use one account (5600), or two separate accounts?
4. Do cash over/short (6910) and petty cash expenses (6900) belong in operating expenses?
5. Is the arrangement for clearing opening balance equity (3900) after go-live acceptable?
6. **Advance while invoices are open (decision 0113):** a receipt normally settles the customer's open invoices first, oldest first, and only the excess becomes an advance with its own payment tax invoice. As an exception (permission `sales.advance_with_open_invoices`, a reason, audited), a receipt may be kept whole as an advance while an invoice is still open, e.g. a deposit for a new project while an old invoice is disputed. Is this treatment acceptable, and should it need anything more (a limit, or a review report)?
