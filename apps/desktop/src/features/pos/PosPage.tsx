/**
 * The point of sale (design 03; decisions 0003–0005, 0059, 0062). Only on a PC enrolled as POS,
 * on the signed-in cashier's own open shift. Keyboard and scanner first: F2 search (a scanned
 * barcode adds the item at once), F6 hold, F12 pay. The cash customer is the default; a
 * VAT-registered customer gets a full tax invoice with their TRN.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Banknote,
  Clock,
  Minus,
  Pause,
  Pencil,
  Plus,
  Search,
  Trash2,
  Undo2,
  Vault,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatQuantity, roundDiv } from '@artepool/shared';
import type { HeldCart, ItemListItem, PosState } from '@artepool/shared/contracts';
import { useSave } from '../../api/hooks';
import { Alert, Button, Card, Chip, cx, iconClass, Note, PageHeader } from '../../ui';
import { useCan, useDisplayName, useErrorText } from '../auth/context';
import { money } from '../masterdata/format';
import { localName, useCategories } from '../masterdata/refs';
import { CustomerPicker, useWalkInCustomer } from '../sales/CustomerPicker';
import { useLineRefs, useLinesPreview } from '../sales/LineEditor';
import { POS_INVALIDATE, POS_PATHS, useCatalog, useHeldCarts, usePosState } from './api';
import {
  addItem,
  cartStore,
  clearCart,
  emptyCart,
  removeLine,
  stepQuantity,
  useCart,
  type Cart,
} from './cart';
import { HeldCartsDialog } from './HeldCartsDialog';
import { LineDialog } from './LineDialog';
import { PaymentDialog } from './PaymentDialog';
import { ReturnDialog } from './ReturnDialog';
import { OpenShiftCard } from './shift/OpenShiftCard';
import styles from './pos.module.css';

export function PosPage() {
  const { t } = useTranslation('pos');
  const nameOf = useDisplayName();
  const state = usePosState();
  const errorText = useErrorText();

  let body;
  if (state.isLoading) body = <Note>{t('loading')}</Note>;
  else if (state.error) body = <Alert>{errorText(state.error)}</Alert>;
  else if (!state.data!.isPosDevice) body = <Alert tone="warn">{t('notPosDevice')}</Alert>;
  else if (state.data!.drawerBusyWith)
    body = (
      <Alert tone="warn">{t('drawerBusy', { name: nameOf(state.data!.drawerBusyWith) })}</Alert>
    );
  else if (!state.data!.shift) body = <OpenShiftCard />;
  else return <Register state={state.data!} />;

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {body}
    </>
  );
}

function Register({ state }: { state: PosState }) {
  const { t, i18n } = useTranslation('pos');
  const can = useCan();
  const cart = useCart();
  const walkIn = useWalkInCustomer();
  const refs = useLineRefs();
  const totals = useLinesPreview(cart.lines, '');
  const searchRef = useRef<HTMLInputElement>(null);
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [showHeld, setShowHeld] = useState(false);
  const [returning, setReturning] = useState(false);
  const held = useHeldCarts();
  const errorText = useErrorText();
  const [problem, setProblem] = useState<string | null>(null);

  const hold = useSave(
    (api, c: Cart, key) =>
      api.post<HeldCart>(
        POS_PATHS.heldCarts,
        {
          cartId: c.cartId,
          ...(c.customer && !c.customer.isWalkIn ? { customerId: c.customer.id } : {}),
          label: c.customer && !c.customer.isWalkIn ? c.customer.name : undefined,
          cart: { lines: c.lines, customer: c.customer, removals: c.removals },
        },
        { idempotencyKey: key },
      ),
    {
      invalidate: POS_INVALIDATE,
      onSuccess: () => cartStore.reset(),
    },
  );
  const canPay = cart.lines.length > 0 && totals.complete && refs.ready;

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'F2') {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === 'F12' && canPay) {
        event.preventDefault();
        setPaying(true);
      } else if (event.key === 'F6' && cart.lines.length > 0) {
        event.preventDefault();
        hold.mutate(cartStore.get(), { onError: (e) => setProblem(errorText(e)) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canPay, cart.lines.length, hold, errorText]);

  const customer = cart.customer ?? walkIn;
  const name = (l: { nameAr: string; nameEn: string }) => localName(i18n.language)(l);
  const heldCount = held.data?.length ?? 0;

  return (
    <div className={styles.register}>
      <div className={styles.bar}>
        <span className={styles.barTitle}>{t('title')}</span>
        <Chip tone="neutral" icon={<Clock aria-hidden="true" />}>
          <bdi>{state.shift!.shiftNumber}</bdi>
        </Chip>
        {state.dropDue && (
          <Chip tone="warn" icon={<Vault aria-hidden="true" />}>
            {t('dropDue')}
          </Chip>
        )}
        <span className={styles.spacer} />
        <Button onPress={() => setShowHeld(true)} isDisabled={heldCount === 0}>
          <Pause className={iconClass.sm} aria-hidden="true" />
          {t('held', { count: heldCount })}
        </Button>
        <Button onPress={() => setReturning(true)}>
          <Undo2 className={iconClass.sm} aria-hidden="true" />
          {t('return')}
        </Button>
        <Link to="/pos/shift" className={styles.linkButton}>
          <Banknote className={iconClass.sm} aria-hidden="true" />
          {t('shift')}
        </Link>
      </div>

      <Catalog searchRef={searchRef} onAdd={(item) => cartStore.set((c) => addItem(c, item))} />

      <Card className={styles.cart} aria-label={t('cart')}>
        <div className={styles.cartHead}>
          <h2>{t('cart')}</h2>
          <Chip tone="neutral">{cart.lines.length}</Chip>
          <span className={styles.spacer} />
          <Button
            variant="dangerGhost"
            isDisabled={cart.lines.length === 0}
            onPress={() => cartStore.set((c) => clearCart(c))}
          >
            <Trash2 className={iconClass.sm} aria-hidden="true" />
            {t('clear')}
          </Button>
        </div>
        <CustomerPicker
          value={cart.customer}
          onChange={(c) => cartStore.set((cur) => ({ ...cur, customer: c }))}
        />
        {customer && (
          <Note>
            {customer.isVatRegistered
              ? t('fullInvoice', { trn: customer.trn ?? '' })
              : t('simplifiedInvoice')}
          </Note>
        )}
        {cart.lines.length === 0 ? (
          <p className={styles.empty}>{t('emptyCart')}</p>
        ) : (
          <ul className={styles.lines}>
            {cart.lines.map((l, i) => {
              const p = totals.lines[i];
              return (
                <li key={l.key} className={styles.line}>
                  <div className={styles.lineName}>
                    <b>{name(l)}</b>
                    <span className={styles.muted}>
                      <bdi>{l.code}</bdi>
                      {l.discount.trim() !== '' &&
                        ` · ${t('discountShort', { value: l.discount })}`}
                      {l.unitPrice.trim() !== '' && ` · ${t('priceChanged')}`}
                    </span>
                  </div>
                  <div className={styles.qty}>
                    <Button
                      aria-label={t('less')}
                      onPress={() => cartStore.set((c) => stepQuantity(c, l.key, -1))}
                    >
                      <Minus className={iconClass.sm} aria-hidden="true" />
                    </Button>
                    <bdi className={styles.qtyValue}>{l.quantity}</bdi>
                    <Button
                      aria-label={t('more')}
                      onPress={() => cartStore.set((c) => stepQuantity(c, l.key, 1))}
                    >
                      <Plus className={iconClass.sm} aria-hidden="true" />
                    </Button>
                  </div>
                  <bdi className={styles.amount}>{p ? money(p.grossFils) : '—'}</bdi>
                  <Button
                    aria-label={t('editLine')}
                    variant="ghost"
                    onPress={() => setEditing(l.key)}
                  >
                    <Pencil className={iconClass.sm} aria-hidden="true" />
                  </Button>
                  <Button
                    aria-label={t('removeLine')}
                    variant="dangerGhost"
                    onPress={() => cartStore.set((c) => removeLine(c, l.key))}
                  >
                    <Trash2 className={iconClass.sm} aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <dl className={styles.totals}>
          <dt>{t('net')}</dt>
          <dd>
            <bdi>{money(totals.netFils)}</bdi>
          </dd>
          <dt>{t('vat')}</dt>
          <dd>
            <bdi>{money(totals.vatFils)}</bdi>
          </dd>
          <dt className={styles.grand}>{t('total')}</dt>
          <dd className={styles.grand}>
            <bdi>
              {money(totals.totalFils)} {t('currency')}
            </bdi>
          </dd>
        </dl>
        {problem && <Alert>{problem}</Alert>}
        <div className={styles.payRow}>
          <Button
            isDisabled={cart.lines.length === 0 || hold.isPending}
            onPress={() => hold.mutate(cart, { onError: (e) => setProblem(errorText(e)) })}
          >
            <Pause className={iconClass.sm} aria-hidden="true" />
            {t('hold')} <kbd>{t('keys.f6')}</kbd>
          </Button>
          <Button
            variant="fin"
            className={styles.pay}
            isDisabled={!canPay}
            onPress={() => setPaying(true)}
          >
            {t('pay')} · <bdi>{money(totals.totalFils)}</bdi> <kbd>{t('keys.f12')}</kbd>
          </Button>
        </div>
        {!can('sales.discount_over_limit') && <Note>{t('discountLimitNote')}</Note>}
      </Card>

      {paying && (
        <PaymentDialog
          state={state}
          totalFils={totals.totalFils}
          onClose={() => setPaying(false)}
          onDone={() => {
            setPaying(false);
            searchRef.current?.focus();
          }}
        />
      )}
      {editing && (
        <LineDialog
          line={cart.lines.find((l) => l.key === editing)!}
          onClose={() => setEditing(null)}
        />
      )}
      {showHeld && (
        <HeldCartsDialog
          onClose={() => setShowHeld(false)}
          onResume={(c) => {
            cartStore.set({ ...emptyCart(), ...c });
            setShowHeld(false);
          }}
        />
      )}
      {returning && <ReturnDialog state={state} onClose={() => setReturning(false)} />}
    </div>
  );
}

/** Search (name words, code, barcode), categories and the item cards with their stock. */
function Catalog(props: {
  searchRef: React.RefObject<HTMLInputElement | null>;
  onAdd: (item: ItemListItem) => void;
}) {
  const { t, i18n } = useTranslation('pos');
  const name = localName(i18n.language);
  const categories = useCategories();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 200);
    return () => clearTimeout(timer);
  }, [text]);
  const catalog = useCatalog(q, category);
  const items = (catalog.data?.items ?? []).filter((i) => i.isActive && i.isSellable && i.price);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    // A scanner types the barcode and Enter: the exact match goes straight to the cart.
    const typed = text.trim();
    const exact =
      items.find(
        (i) => i.primaryBarcode === typed || i.code.toLowerCase() === typed.toLowerCase(),
      ) ??
      (q === typed && catalog.data?.exactMatchId
        ? items.find((i) => i.id === catalog.data?.exactMatchId)
        : undefined) ??
      (items.length === 1 ? items[0] : undefined);
    if (exact) {
      props.onAdd(exact);
      setText('');
    }
  };

  return (
    <Card className={styles.catalog}>
      <div className={styles.search}>
        <Search className={iconClass.md} aria-hidden="true" />
        <input
          ref={props.searchRef}
          className={styles.searchInput}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('searchHint')}
          aria-label={t('search')}
          autoFocus
        />
        <kbd>{t('keys.f2')}</kbd>
      </div>
      <div className={styles.cats} role="group" aria-label={t('categories')}>
        <button
          type="button"
          className={cx(styles.cat, category === null && styles.catOn)}
          aria-pressed={category === null}
          onClick={() => setCategory(null)}
        >
          {t('allCategories')}
        </button>
        {(categories.data ?? [])
          .filter((c) => c.isActive)
          .map((c) => (
            <button
              key={c.id}
              type="button"
              className={cx(styles.cat, category === c.id && styles.catOn)}
              aria-pressed={category === c.id}
              onClick={() => setCategory(c.id)}
            >
              {name(c)}
            </button>
          ))}
      </div>
      {items.length === 0 && !catalog.isLoading ? (
        <p className={styles.empty}>{t('noItems')}</p>
      ) : (
        <ul className={styles.grid}>
          {items.map((item) => {
            const onHand = item.stock ? BigInt(item.stock.onHandMilli) : null;
            const out = onHand !== null && onHand <= 0n;
            return (
              <li key={item.id}>
                <button type="button" className={styles.itemCard} onClick={() => props.onAdd(item)}>
                  <span className={styles.itemName}>{name(item)}</span>
                  <span className={styles.muted}>
                    <bdi>{item.code}</bdi>
                  </span>
                  <span className={styles.itemFoot}>
                    <b>
                      <bdi>{money(roundPrice(item.price!.price4dp))}</bdi>
                    </b>
                    {onHand !== null && (
                      <span className={cx(styles.stock, out && styles.stockOut)}>
                        {out
                          ? t('outOfStock')
                          : t('inStock', { qty: formatQuantity(onHand).replace(/\.?0+$/, '') })}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** The item card shows the price to the fils, through the shared rounding helper. */
const roundPrice = (price4dp: string): bigint => roundDiv(BigInt(price4dp), 100n);
