/**
 * The reconciliation report on paper (M7, decision 0119), for the accountant: the seven steps,
 * each green or red, with its figures and the problems found. Arabic and English side by side,
 * in the app's print fonts.
 */
import type {
  ReconciliationFigure,
  ReconciliationReport,
  ReconciliationStep,
} from '@artepool/shared/contracts';
import type { Db } from '../../platform/db/pool';
import { company } from '../printing/service';
import { date, escapeHtml, fonts, money } from '../printing/templates';

type Pair = readonly [string, string];

const STEPS: Record<ReconciliationStep, Pair> = {
  stock: ['المخزون', 'Stock'],
  cash: ['النقد والورديات', 'Cash and shifts'],
  invoices: ['الفواتير والتسلسل', 'Invoices and numbering'],
  vat: ['الضريبة', 'VAT'],
  accounts: ['الحسابات', 'Accounts'],
  audit: ['سجل المراقبة', 'Audit log'],
  backup: ['النسخة الاحتياطية', 'Backup'],
};

const CHECKS: Record<string, Pair> = {
  stock_vs_ledger: ['رصيد المخزون = مجموع الحركات', 'Stock on hand = sum of movements'],
  oversells_reviewed: ['تمت مراجعة كل عمليات البيع بالسالب', 'Every oversell reviewed'],
  cash_shifts: ['النقد المتوقع والمعدود لكل وردية', 'Expected and counted cash of every shift'],
  variances_accepted: ['تم قبول كل الفروقات', 'Every variance accepted'],
  numbering_gaps: ['الترقيم متسلسل دون فجوات', 'Numbering without gaps'],
  document_totals: ['إجمالي كل مستند = مجموع سطوره', 'Each document total = sum of its lines'],
  invoice_formats: ['شكل الفاتورة وسلسلة الترقيم صحيحان', 'Invoice format and series right'],
  vat_ledger: ['ضريبة المستندات = حساب الضريبة', 'VAT on documents = output VAT account'],
  vat_period: ['ضريبة الفترة = حركة الحساب في الفترة', 'Period VAT = account movement'],
  journals_balanced: ['كل قيد متوازن', 'Every journal entry balanced'],
  trial_balance: ['إجمالي المدين = إجمالي الدائن', 'Total debits = total credits'],
  postings: ['كل مستند مُرحّل مرة واحدة', 'Everything posted once'],
  receivables: ['حساب ذمم العملاء = أرصدة العملاء', 'Receivables = customer balances'],
  settlements: ['التحصيلات مطابقة للفواتير', 'Settlements match'],
  audit_chain: ['سلسلة سجل المراقبة سليمة', 'Audit chain intact'],
  audit_anchors: ['البصمات المحفوظة مطابقة', 'Saved anchors match'],
  restore_test: ['نجحت آخر تجربة استرجاع', 'Last restore test passed'],
};

const FIGURES: Record<string, Pair> = {
  movements: ['حركات المخزون في الفترة', 'Stock movements in the period'],
  oversells: ['عمليات البيع بالسالب في الفترة', 'Oversells in the period'],
  oversellsPending: ['عمليات بيع بالسالب بانتظار المراجعة', 'Oversells waiting for review'],
  stockValue: ['قيمة المخزون', 'Stock value'],
  shiftsClosed: ['الورديات المغلقة', 'Shifts closed'],
  expectedCash: ['النقد المتوقع', 'Expected cash'],
  countedCash: ['النقد المعدود', 'Counted cash'],
  variance: ['الفرق', 'Variance'],
  documentsTotal: [
    'إجمالي المستندات (بعد الإشعارات الدائنة)',
    'Documents total (after credit notes)',
  ],
  vatInvoices: ['ضريبة الفواتير', 'VAT on invoices'],
  vatAdvances: ['ضريبة الدفعات المقدمة', 'VAT on advance payments'],
  vatCreditNotes: ['ضريبة الإشعارات الدائنة', 'VAT on credit notes'],
  vatDebitNotes: ['ضريبة الإشعارات المدينة', 'VAT on debit notes'],
  vatDocuments: ['صافي ضريبة المستندات', 'Net VAT on documents'],
  vatAccount: ['حركة حساب الضريبة المستحقة', 'Output VAT account movement'],
  totalDebits: ['إجمالي المدين', 'Total debits'],
  receivables: ['ذمم العملاء', 'Receivables'],
  customerAdvances: ['دفعات مقدمة من العملاء', 'Customer advances'],
  chainEntries: ['قيود سجل المراقبة', 'Audit chain entries'],
  anchors: ['البصمات المحفوظة', 'Saved anchors'],
  lastRestoreTest: ['آخر تجربة استرجاع', 'Last restore test'],
  lastRestoreResult: ['نتيجتها', 'Its result'],
};

const label = (pair: Pair | undefined, fallback: string): string =>
  pair
    ? `<span class="ar">${escapeHtml(pair[0])}</span> <span class="en">${escapeHtml(pair[1])}</span>`
    : escapeHtml(fallback);

function figureLabel(key: string): string {
  if (key.startsWith('series:')) {
    const code = key.slice('series:'.length);
    return label([`السلسلة ${code}`, `Series ${code}`], key);
  }
  return label(FIGURES[key], key);
}

function figureValue(f: ReconciliationFigure): string {
  if (f.value === null) return '—';
  if (f.kind === 'fils') return `<bdi>${money(f.value)}</bdi>`;
  if (f.key === 'lastRestoreTest') return `<bdi>${escapeHtml(date(f.value.slice(0, 10)))}</bdi>`;
  return `<bdi>${escapeHtml(f.value)}</bdi>`;
}

const mark = (ok: boolean) =>
  ok
    ? '<span class="ok">✓ <span class="ar">مطابق</span> <span class="en">OK</span></span>'
    : '<span class="bad">✗ <span class="ar">توجد مشكلة</span> <span class="en">Problem</span></span>';

export async function reconciliationHtml(
  db: Db,
  report: ReconciliationReport,
  auth: { permissions: ReadonlySet<string> } | null,
  /** A rehearsal's report (decision 0119): its figures come from the rehearsal's own database. */
  options: { rehearsal?: boolean } = {},
): Promise<string> {
  const { seller } = await company(db);
  const seesCost = auth?.permissions.has('stock.view_cost') ?? false;
  const steps = report.steps
    .map((s, i) => {
      const figures = s.figures
        .map((f) => (f.key === 'stockValue' && !seesCost ? { ...f, value: null } : f))
        .map((f) => `<tr><td>${figureLabel(f.key)}</td><td class="num">${figureValue(f)}</td></tr>`)
        .join('');
      const checks = s.checks
        .map(
          (c) =>
            `<li>${c.ok ? '✓' : '✗'} ${label(CHECKS[c.name], c.name)}${
              c.ok
                ? ''
                : `<ul class="examples">${c.examples
                    .map((e) => `<li><bdi>${escapeHtml(e)}</bdi></li>`)
                    .join('')}${
                    c.problems > c.examples.length
                      ? `<li>+${c.problems - c.examples.length}</li>`
                      : ''
                  }</ul>`
            }</li>`,
        )
        .join('');
      return `<section class="${s.ok ? 'is-ok' : 'is-bad'}">
        <h2>${i + 1}. ${label(STEPS[s.step], s.step)} ${mark(s.ok)}</h2>
        <ul class="checks">${checks}</ul>
        ${figures ? `<table>${figures}</table>` : ''}
      </section>`;
    })
    .join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
${fonts()}
@page { size: A4; margin: 12mm; }
body { font-family: 'ARTEPOOL Arabic', 'Plex Arabic', sans-serif; font-size: 9.5pt; color: #111; }
h1 { font-size: 15pt; margin: 0 0 2mm; }
h2 { font-size: 11pt; margin: 0 0 2mm; }
.en { color: #444; font-family: 'Plex Arabic', sans-serif; }
.meta { margin: 0 0 4mm; }
.overall { font-size: 12pt; margin: 0 0 4mm; }
section { border: 0.3mm solid #999; border-radius: 1.5mm; padding: 3mm; margin: 0 0 3mm; break-inside: avoid; }
section.is-bad { border-color: #b00020; }
.ok { color: #0a6b2e; }
.bad { color: #b00020; }
ul { margin: 0; padding-inline-start: 5mm; }
.checks > li { margin: 0.5mm 0; }
.examples { font-size: 8.5pt; color: #b00020; }
table { width: 100%; border-collapse: collapse; margin-top: 2mm; }
td { border-top: 0.2mm solid #ddd; padding: 1mm; }
td.num { text-align: end; white-space: nowrap; }
</style></head><body>
<h1>${escapeHtml(seller.legal_name_ar)} <span class="en">${escapeHtml(seller.legal_name_en)}</span></h1>
<h2>${label(['تقرير المطابقة', 'Reconciliation report'], '')}${
    options.rehearsal ? ` — ${label(['بروفة', 'rehearsal'], '')}` : ''
  }</h2>
${
  options.rehearsal
    ? `<p class="meta">${label(['من قاعدة بيانات البروفة نفسها، واتمسحت بعد البروفة', 'From the rehearsal’s own database, deleted after the rehearsal'], '')}</p>`
    : ''
}
<p class="meta">${label(['الفترة', 'Period'], '')}: <bdi>${escapeHtml(date(report.from))} – ${escapeHtml(
    date(report.to),
  )}</bdi> · ${label(['وقت التشغيل', 'Run at'], '')}: <bdi>${escapeHtml(
    new Date(report.ranAt).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' }),
  )}</bdi></p>
<p class="overall">${mark(report.ok)}</p>
${steps}
</body></html>`;
}
