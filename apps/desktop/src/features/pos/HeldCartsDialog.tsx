/** Held carts on this PC: resume one (it comes back to the cart) or discard it. */
import { useTranslation } from 'react-i18next';
import type { HeldCart } from '@artepool/shared/contracts';
import { useSave } from '../../api/hooks';
import { Alert, Button, Dialog, DialogFooter, Note } from '../../ui';
import { useDisplayName, useErrorText } from '../auth/context';
import { formatTime } from '../../lib/format';
import { POS_INVALIDATE, POS_PATHS, useHeldCarts } from './api';
import type { Cart } from './cart';
import styles from './pos.module.css';

export function HeldCartsDialog(props: {
  onClose: () => void;
  onResume: (cart: Partial<Cart>) => void;
}) {
  const { t } = useTranslation('pos');
  const nameOf = useDisplayName();
  const errorText = useErrorText();
  const held = useHeldCarts();
  const act = useSave(
    (api, input: { cart: HeldCart; action: 'resume' | 'discard' }, key) =>
      api.post<HeldCart>(
        POS_PATHS.heldCart(input.cart.id, input.action),
        {},
        { idempotencyKey: key },
      ),
    {
      invalidate: POS_INVALIDATE,
      onSuccess: (result, input) => {
        if (input.action !== 'resume') return;
        const saved = result.cart as Partial<Cart>;
        props.onResume({
          cartId: result.cartId,
          lines: saved.lines ?? [],
          customer: saved.customer ?? null,
          removals: saved.removals ?? [],
          heldCartId: result.id,
        });
      },
    },
  );
  const list = held.data ?? [];
  return (
    <Dialog isOpen onClose={props.onClose} title={t('heldTitle')}>
      {list.length === 0 && <Note>{t('heldEmpty')}</Note>}
      <ul className={styles.heldList}>
        {list.map((c) => (
          <li key={c.id} className={styles.heldItem}>
            <span>
              <b>{c.label ?? t('heldNoLabel')}</b>
              <span className={styles.muted}>
                {' '}
                · {nameOf(c.heldByName)} · <bdi>{formatTime(c.heldAt)}</bdi> ·{' '}
                {t('heldLines', { count: Array.isArray(c.cart.lines) ? c.cart.lines.length : 0 })}
              </span>
            </span>
            <span className={styles.heldActions}>
              <Button
                variant="dangerGhost"
                onPress={() => act.mutate({ cart: c, action: 'discard' })}
              >
                {t('discard')}
              </Button>
              <Button variant="primary" onPress={() => act.mutate({ cart: c, action: 'resume' })}>
                {t('resume')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {act.error !== null && <Alert>{errorText(act.error)}</Alert>}
      <DialogFooter>
        <Button onPress={props.onClose}>{t('close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
