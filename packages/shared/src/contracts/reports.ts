/**
 * The owner's dashboard (decisions 0039, 0081): what was sold, the VAT, the profit, and the state
 * of cash, receivables and stock. Owner only. Amounts in fils, quantities in thousandths.
 */
import { z } from 'zod';
import { DateText } from './inventory';

export const DASHBOARD_PERIODS = ['today', 'week', 'month', 'year', 'custom'] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

export const DashboardQuery = z
  .object({
    period: z.enum(DASHBOARD_PERIODS).default('today'),
    from: DateText.optional(),
    to: DateText.optional(),
  })
  .refine((q) => q.period !== 'custom' || (q.from !== undefined && q.to !== undefined), {
    path: ['from'],
    message: 'required',
  })
  .refine((q) => q.period !== 'custom' || q.from! <= q.to!, {
    path: ['to'],
    message: 'before_from',
  });
export type DashboardQuery = z.infer<typeof DashboardQuery>;

/** The four figures, after returns: total with VAT, without VAT, VAT, cost and profit. */
export interface DashboardFigures {
  totalFils: string;
  netFils: string;
  vatFils: string;
  costFils: string;
  profitFils: string;
  documents: number;
}

export interface DashboardName {
  nameAr: string;
  nameEn: string;
}

export interface DashboardResponse {
  from: string;
  to: string;
  /** The same number of days just before, for the comparison. */
  previousFrom: string;
  previousTo: string;
  current: DashboardFigures;
  previous: DashboardFigures;
  daily: { date: string; totalFils: string; profitFils: string }[];
  byChannel: { posFils: string; a4Fils: string };
  /** Money received in the period by payment method (refunds and reversals taken off). */
  byMethod: (DashboardName & { methodId: string; kind: string; amountFils: string })[];
  /** Of this period's sales, what is still unpaid. */
  unpaidFils: string;
  byCashier: (DashboardName & { userId: string; totalFils: string; documents: number })[];
  topItems: (DashboardName & {
    itemId: string;
    code: string;
    quantityMilli: string;
    netFils: string;
    profitFils: string;
  })[];
  topCustomers: { customerId: string; name: string; totalFils: string }[];
  cash: {
    openShifts: (DashboardName & {
      shiftId: string;
      shiftNumber: string;
      registerCode: string;
      expectedFils: string;
    })[];
    drawersFils: string;
    safeFils: string;
    /** Over (+) or short (−) of the shifts closed in the period. */
    varianceFils: string;
  };
  receivables: {
    totalFils: string;
    overdueFils: string;
    customers: { customerId: string; name: string; balanceFils: string; overdueFils: string }[];
  };
  stock: {
    valueFils: string;
    toReorder: number;
    items: (DashboardName & {
      itemId: string;
      code: string;
      onHandMilli: string;
      reorderLevelMilli: string;
    })[];
  };
}
