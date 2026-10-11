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
import { CountPage } from '../features/inventory/CountPage';
import { CountsPage } from '../features/inventory/CountsPage';
import { OpeningStockPage } from '../features/inventory/OpeningStockPage';
import { ReviewsPage } from '../features/inventory/ReviewsPage';
import { ItemsPage } from '../features/items/ItemsPage';
import { CompanyPanel } from '../features/settings/company/CompanyPanel';
import { ListsPanel } from '../features/settings/lists/ListsPanel';
import { TaxPanel } from '../features/settings/tax/TaxPanel';
import { SuppliersPage } from '../features/suppliers/SuppliersPage';
import { AuditPanel } from '../features/settings/audit/AuditPanel';
import { DevicesPanel } from '../features/settings/devices/DevicesPanel';
import { SettingsIndex, SettingsPage } from '../features/settings/SettingsPage';
import { UsersPanel } from '../features/settings/users/UsersPanel';
import { Shell } from './Shell';

const root = createRootRoute({ component: Shell });
const home = createRoute({ getParentRoute: () => root, path: '/', component: HomePage });
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
const company = createRoute({
  getParentRoute: () => settings,
  path: 'company',
  component: CompanyPanel,
});
const tax = createRoute({ getParentRoute: () => settings, path: 'tax', component: TaxPanel });
const lists = createRoute({ getParentRoute: () => settings, path: 'lists', component: ListsPanel });

const routeTree = root.addChildren([
  home,
  items,
  openingStock,
  counts,
  count,
  reviews,
  customers,
  suppliers,
  accounting,
  settings.addChildren([settingsIndex, company, users, tax, lists, devices, audit]),
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
