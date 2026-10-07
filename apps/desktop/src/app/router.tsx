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
import { HomePage } from '../features/home/HomePage';
import { AuditPanel } from '../features/settings/audit/AuditPanel';
import { DevicesPanel } from '../features/settings/devices/DevicesPanel';
import { SettingsIndex, SettingsPage } from '../features/settings/SettingsPage';
import { UsersPanel } from '../features/settings/users/UsersPanel';
import { Shell } from './Shell';

const root = createRootRoute({ component: Shell });
const home = createRoute({ getParentRoute: () => root, path: '/', component: HomePage });
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

const routeTree = root.addChildren([
  home,
  settings.addChildren([settingsIndex, users, devices, audit]),
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
