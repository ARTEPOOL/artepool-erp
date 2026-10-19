/**
 * Screens and their addresses. The app keeps its place in memory only: every sign-in starts on
 * the dashboard, whoever signed in before.
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { AccountingPage } from '../features/accounting/AccountingPage';
import { CustomersPage } from '../features/customers/CustomersPage';
import { HomePage } from '../features/home/HomePage';
import { InvoicePage } from '../features/invoices/InvoicePage';
import { InvoicesPage } from '../features/invoices/InvoicesPage';
import { CountPage } from '../features/inventory/CountPage';
import { CountsPage } from '../features/inventory/CountsPage';
import { OpeningStockPage } from '../features/inventory/OpeningStockPage';
import { ReviewsPage } from '../features/inventory/ReviewsPage';
import { ItemsPage } from '../features/items/ItemsPage';
import { QuotationPage } from '../features/quotations/QuotationPage';
import { QuotationsPage } from '../features/quotations/QuotationsPage';
import { ReceiptPage } from '../features/receipts/ReceiptPage';
import { ReceiptsPage } from '../features/receipts/ReceiptsPage';
import { CompanyPanel } from '../features/settings/company/CompanyPanel';
import { ListsPanel } from '../features/settings/lists/ListsPanel';
import { TaxPanel } from '../features/settings/tax/TaxPanel';
import { SuppliersPage } from '../features/suppliers/SuppliersPage';
import { AuditPanel } from '../features/settings/audit/AuditPanel';
import { PrintDesignerPanel } from '../features/settings/print/PrintDesignerPanel';
import { BackupPanel } from '../features/settings/backup/BackupPanel';
import { DevicesPanel } from '../features/settings/devices/DevicesPanel';
import { SettingsIndex, SettingsPage } from '../features/settings/SettingsPage';
import { UsersPanel } from '../features/settings/users/UsersPanel';
import { PosPage } from '../features/pos/PosPage';
import { ShiftPage } from '../features/pos/shift/ShiftPage';
import { ShiftsPage } from '../features/pos/shift/ShiftsPage';
import { OwnerDashboard } from '../features/reports/OwnerDashboard';
import { Shell } from './Shell';

const root = createRootRoute({ component: Shell });
const home = createRoute({ getParentRoute: () => root, path: '/', component: HomePage });
// Sales (decision 0045): Invoices (A4), Quotations and Receipts; `new` opens an empty form.
const invoices = createRoute({
  getParentRoute: () => root,
  path: 'invoices',
  component: InvoicesPage,
});
const invoice = createRoute({
  getParentRoute: () => root,
  path: 'invoices/$documentId',
  component: InvoicePage,
});
const quotations = createRoute({
  getParentRoute: () => root,
  path: 'quotations',
  component: QuotationsPage,
});
const quotation = createRoute({
  getParentRoute: () => root,
  path: 'quotations/$quotationId',
  component: QuotationPage,
});
const receipts = createRoute({
  getParentRoute: () => root,
  path: 'receipts',
  component: ReceiptsPage,
});
const receipt = createRoute({
  getParentRoute: () => root,
  path: 'receipts/$paymentId',
  // `new?customerId=…` opens the form with the customer chosen (from an invoice or a customer).
  validateSearch: (search: Record<string, unknown>): { customerId?: string } =>
    typeof search.customerId === 'string' && /^[1-9][0-9]*$/.test(search.customerId)
      ? { customerId: search.customerId }
      : {},
  component: ReceiptPage,
});
const pos = createRoute({ getParentRoute: () => root, path: 'pos', component: PosPage });
const posShift = createRoute({
  getParentRoute: () => root,
  path: 'pos/shift',
  component: ShiftPage,
});
const shifts = createRoute({ getParentRoute: () => root, path: 'shifts', component: ShiftsPage });
const reports = createRoute({
  getParentRoute: () => root,
  path: 'reports',
  component: OwnerDashboard,
});
const items = createRoute({ getParentRoute: () => root, path: 'items', component: ItemsPage });
// Stock pages reached from Items & stock (design 07) and the dashboard alerts.
const openingStock = createRoute({
  getParentRoute: () => root,
  path: 'stock/opening',
  component: OpeningStockPage,
});
const counts = createRoute({
  getParentRoute: () => root,
  path: 'stock/counts',
  component: CountsPage,
});
const count = createRoute({
  getParentRoute: () => root,
  path: 'stock/counts/$countId',
  component: CountPage,
});
const reviews = createRoute({
  getParentRoute: () => root,
  path: 'stock/reviews',
  component: ReviewsPage,
});
const customers = createRoute({
  getParentRoute: () => root,
  path: 'customers',
  component: CustomersPage,
});
const suppliers = createRoute({
  getParentRoute: () => root,
  path: 'suppliers',
  component: SuppliersPage,
});
const accounting = createRoute({
  getParentRoute: () => root,
  path: 'accounting',
  component: AccountingPage,
});
const settings = createRoute({
  getParentRoute: () => root,
  path: 'settings',
  component: SettingsPage,
});
const settingsIndex = createRoute({
  getParentRoute: () => settings,
  path: '/',
  component: SettingsIndex,
});
const users = createRoute({ getParentRoute: () => settings, path: 'users', component: UsersPanel });
const devices = createRoute({
  getParentRoute: () => settings,
  path: 'devices',
  component: DevicesPanel,
});
const audit = createRoute({ getParentRoute: () => settings, path: 'audit', component: AuditPanel });
const backup = createRoute({
  getParentRoute: () => settings,
  path: 'backup',
  component: BackupPanel,
});
const company = createRoute({
  getParentRoute: () => settings,
  path: 'company',
  component: CompanyPanel,
});
const tax = createRoute({ getParentRoute: () => settings, path: 'tax', component: TaxPanel });
const lists = createRoute({ getParentRoute: () => settings, path: 'lists', component: ListsPanel });
const print = createRoute({
  getParentRoute: () => settings,
  path: 'print',
  component: PrintDesignerPanel,
});

const routeTree = root.addChildren([
  reports,
  home,
  pos,
  posShift,
  shifts,
  invoices,
  invoice,
  quotations,
  quotation,
  receipts,
  receipt,
  items,
  openingStock,
  counts,
  count,
  reviews,
  customers,
  suppliers,
  accounting,
  settings.addChildren([settingsIndex, company, users, tax, lists, devices, print, backup, audit]),
]);

export function createAppRouter(initialPath = '/') {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
