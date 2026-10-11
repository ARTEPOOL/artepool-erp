/** Settings query keys. The read and save hooks are shared by every screen (`api/hooks`). */
import type { QueryKey } from '@tanstack/react-query';

export { useApi, useSave } from '../../api/hooks';

export const KEYS = {
  users: ['settings', 'users'] as QueryKey,
  roles: ['settings', 'roles'] as QueryKey,
  devices: ['settings', 'devices'] as QueryKey,
  audit: ['settings', 'audit'] as QueryKey,
  chain: ['settings', 'audit-chain'] as QueryKey,
};
