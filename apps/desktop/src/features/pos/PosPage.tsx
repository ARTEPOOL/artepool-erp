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
  Brush,
  Clock,
  Cog,
  FlaskConical,
  Minus,
  Package,
  Pause,
  Pencil,
  Plus,
  ScanBarcode,
  Search,
  ShoppingCart,
  Trash2,
  Undo2,
  UserRound,
  Landmark,
  Lock,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatQuantity, roundDiv } from '@artepool/shared';
import type { CategoryItem, HeldCart, ItemListItem, PosState } from '@artepool/shared/contracts';
import { useSave } from '../../api/hooks';
import {
  Alert,
  Button,
  Card,
  Chip,
  cx,
  Dialog,
  iconClass,
  Note,
  PageHeader,
  Tile,
  type Tone,
} from '../../ui';
import { useAuthController, useDisplayName, useErrorText } from '../auth/context';
import { money, rate } from '../masterdata/format';
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
import { useGlobalScan, useScanInput } from '../items/scan';
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
  const auth = useAuthController();
  const nameOf = useDisplayName();
  const cart = useCart();
  const walkIn = useWalkInCustomer();
  const refs = useLineRefs();
  const totals = useLinesPreview(cart.lines, '');
  const searchRef = useRef<HTMLInputElement>(null);
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [showHeld, setShowHeld] = useState(false);
  const [returning, setReturning] = useState(false);
  const [choosingCustomer, setChoosingCustomer] = useState(false);
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
  const isWalkIn = !cart.customer || cart.customer.isWalkIn === true;
  const name = (l: { nameAr: string; nameEn: string }) => localName(i18n.language)(l);
  const heldCount = held.data?.length ?? 0;
  const rates = [...new Set(cart.lines.map((l) => refs.rateOf(l.vatCategoryId)))];
  const vatLabel =
    rates.length === 1 && rates[0] !== undefined
      ? t('vatRate', { rate: rate(rates[0]) })
      : t('vat');

  return (
    <div className={styles.register}>
      <PageHeader
        title={t('newSale')}
        subtitle={t('newSaleHint')}
        tools={
          <div className={styles.tools}>
            <Chip tone="ok" icon={<Clock aria-hidden="true" />}>
              {nameOf(state.shift!.cashierName)} · <bdi>{state.shift!.shiftNumber}</bdi>
            </Chip>
            {state.dropDue && (
              <Chip tone="warn" icon={<Landmark aria-hidden="true" />}>
                {t('dropDue')}
              </Chip>
            )}
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
            {/* Decision 0090: the cashier locks on purpose; the same cashier resumes with the PIN. */}
            <Button onPress={() => void auth.lock()}>
              <Lock className={iconClass.sm} aria-hidden="true" />
              {t('lockScreen')}
            </Button>
          </div>
        }
      />

      <div className={styles.work}>
        <Catalog searchRef={searchRef} onAdd={(item) => cartStore.set((c) => addItem(c, item))} />

        <Card className={styles.cart} padding="compact" aria-label={t('cart')}>
          <div className={styles.cartHead}>
            <h2>
              {t('cart')} <span className={styles.count}>{cart.lines.length}</span>
            </h2>
            <span className={styles.cartActions}>
              <Button
                variant="ghost"
                isDisabled={cart.lines.length === 0 || hold.isPending}
                onPress={() => hold.mutate(cart, { onError: (e) => setProblem(errorText(e)) })}
              >
                <Pause className={iconClass.sm} aria-hidden="true" />
                {t('hold')}
              </Button>
              <Button
                variant="dangerGhost"
                isDisabled={cart.lines.length === 0}
                onPress={() => cartStore.set((c) => clearCart(c))}
              >
                <Trash2 className={iconClass.sm} aria-hidden="true" />
                {t('clear')}
              </Button>
            </span>
          </div>

          <button
            type="button"
            className={styles.customer}
            onClick={() => setChoosingCustomer(true)}
            aria-label={t('chooseCustomer')}
          >
            <Tile tone="primary">
              <UserRound className={iconClass.sm} aria-hidden="true" />
            </Tile>
            <span className={styles.customerText}>
              <b>{isWalkIn ? t('walkIn') : customer?.name}</b>
              <span className={styles.muted}>
                {customer?.isVatRegistered
                  ? t('fullInvoice', { trn: customer.trn ?? '' })
                  : t('simplifiedInvoice')}
              </span>
            </span>
            <span className={styles.customerChange}>
              {isWalkIn ? t('addCustomer') : t('changeCustomer')}
            </span>
          </button>

          {cart.lines.length === 0 ? (
            <div className={styles.emptyCart}>
              <ShoppingCart className={styles.emptyIcon} aria-hidden="true" />
              <b>{t('emptyCartTitle')}</b>
              <span>{t('emptyCart')}</span>
            </div>
          ) : (
            <ul className={styles.lines}>
              {cart.lines.map((l, i) => {
                const p = totals.lines[i];
                const unit = BigInt(l.unitPrice.trim() !== '' ? '0' : l.listPrice4dp);
                return (
                  <li key={l.key} className={styles.line}>
                    <span className={styles.lineName}>
                      <b>{name(l)}</b>
                      <span className={styles.muted}>
                        <bdi>{l.code}</bdi>
                        {l.unitPrice.trim() === '' && (
                          <>
                            {' · '}
                            <bdi>{money(roundDiv(unit, 100n))}</bdi>
                          </>
                        )}
                        {l.discount.trim() !== '' && (
                          <span className={styles.disc}>
                            {' · '}
                            {t('discountShort', { value: l.discount })}
                          </span>
                        )}
                        {l.unitPrice.trim() !== '' && ` · ${t('priceChanged')}`}
                      </span>
                    </span>
                    <b className={styles.amount}>
                      <bdi>{p ? money(p.grossFils) : '—'}</bdi>
                    </b>
                    <span className={styles.qty}>
                      <button
                        type="button"
                        aria-label={t('less')}
                        onClick={() => cartStore.set((c) => stepQuantity(c, l.key, -1))}
                      >
                        <Minus className={iconClass.sm} aria-hidden="true" />
                      </button>
                      <b>{l.quantity}</b>
                      <button
                        type="button"
                        aria-label={t('more')}
                        onClick={() => cartStore.set((c) => stepQuantity(c, l.key, 1))}
                      >
                        <Plus className={iconClass.sm} aria-hidden="true" />
                      </button>
                    </span>
                    <span className={styles.lineActs}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        aria-label={t('editLine')}
                        onClick={() => setEditing(l.key)}
                      >
                        <Pencil className={iconClass.sm} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={cx(styles.iconBtn, styles.remove)}
                        aria-label={t('removeLine')}
                        onClick={() => cartStore.set((c) => removeLine(c, l.key))}
                      >
                        <Trash2 className={iconClass.sm} aria-hidden="true" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <div className={styles.payBox}>
            <div className={styles.sum}>
              <span>{t('net')}</span>
              <bdi>{money(totals.netFils)}</bdi>
            </div>
            <div className={styles.sum}>
              <span>{vatLabel}</span>
              <bdi>{money(totals.vatFils)}</bdi>
            </div>
            <div className={styles.grandRow}>
              <span>{t('totalWithVat')}</span>
              <b>
                <bdi>
                  {money(totals.totalFils)} <small>{t('currency')}</small>
                </bdi>
              </b>
            </div>
            {problem && <Alert>{problem}</Alert>}
            <Button
              variant="fin"
              className={styles.pay}
              isDisabled={!canPay}
              onPress={() => setPaying(true)}
            >
              <span>{t('pay')}</span>
              <kbd>{t('keys.f12')}</kbd>
            </Button>
          </div>
        </Card>
      </div>

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
      {choosingCustomer && (
        <Dialog isOpen onClose={() => setChoosingCustomer(false)} title={t('chooseCustomer')}>
          <div className={styles.customerDialog}>
            <CustomerPicker
              value={null}
              autoFocus
              onChange={(c) => {
                cartStore.set((cur) => ({ ...cur, customer: c }));
                if (c) setChoosingCustomer(false);
              }}
            />
            <Note>{t('fullInvoiceNote')}</Note>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** The tile of a product card: an icon and a tone per category (design 03). */
const CATEGORY_LOOK: Record<string, { icon: LucideIcon; tone: Tone }> = {
  CHEM: { icon: FlaskConical, tone: 'info' },
  EQUIP: { icon: Cog, tone: 'warn' },
  CLEAN: { icon: Brush, tone: 'ok' },
  PARTS: { icon: Wrench, tone: 'credit' },
  SERV: { icon: Wrench, tone: 'primary' },
};
const lookOf = (category: CategoryItem | undefined) =>
  (category && CATEGORY_LOOK[category.code]) ?? { icon: Package, tone: 'primary' as Tone };

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
  const activeCategories = (categories.data ?? []).filter((c) => c.isActive);
  const categoryOf = (id: string) => activeCategories.find((c) => c.id === id);

  // A code entered (a scan, or a code and Enter): the exact match goes straight to the cart. When
  // it is not among the items shown yet, it goes in as soon as the search for it has found it.
  const pending = useRef<string | null>(null);
  const exactFor = (typed: string) =>
    items.find((i) => i.primaryBarcode === typed || i.code.toLowerCase() === typed.toLowerCase()) ??
    (q === typed && catalog.data?.exactMatchId
      ? items.find((i) => i.id === catalog.data?.exactMatchId)
      : undefined);
  const submit = (typed: string) => {
    const exact = exactFor(typed) ?? (q === typed && items.length === 1 ? items[0] : undefined);
    if (exact) {
      pending.current = null;
      props.onAdd(exact);
      setText('');
      return;
    }
    // Searched in every category: a scanned item is found whatever category is chosen.
    pending.current = typed;
    setCategory(null);
    setText(typed);
    setQ(typed);
  };
  useEffect(() => {
    const typed = pending.current;
    if (typed === null || q !== typed || catalog.isFetching || !catalog.data) return;
    pending.current = null;
    const exact = exactFor(typed);
    // Not found: the code stays in the search, which says nothing matches.
    if (exact) {
      props.onAdd(exact);
      setText('');
    }
  });

  // A scan replaces the code scanned before; letters come back in Latin with an Arabic keyboard.
  const scan = useScanInput(setText);
  // A scan with the cursor anywhere else on the screen lands here too.
  useGlobalScan((code) => {
    props.searchRef.current?.focus();
    submit(code);
  });
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    scan.onKeyDown(event);
    if (event.key !== 'Enter') return;
    event.preventDefault();
    // What is in the field now: a scanner's Enter can come before the screen catches up.
    submit(scan.read(event.currentTarget.value.trim()));
  };

  return (
    <Card className={styles.catalog} padding="compact">
      <div className={styles.searchRow}>
        <label className={styles.search}>
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
        </label>
        <Button onPress={() => props.searchRef.current?.focus()}>
          <ScanBarcode className={iconClass.sm} aria-hidden="true" />
          {t('scan')}
        </Button>
      </div>
      <div className={styles.cats} role="group" aria-label={t('categories')}>
        <button
          type="button"
          className={styles.cat}
          aria-pressed={category === null}
          onClick={() => setCategory(null)}
        >
          {t('allCategories')}
        </button>
        {activeCategories.map((c) => (
          <button
            key={c.id}
            type="button"
            className={styles.cat}
            aria-pressed={category === c.id}
            onClick={() => setCategory(c.id)}
          >
            {name(c)}
          </button>
        ))}
      </div>
      <div className={styles.gridHead}>
        <h2>{t('products')}</h2>
        <span className={styles.muted}>{t('productsCount', { count: items.length })}</span>
      </div>
      {items.length === 0 && !catalog.isLoading ? (
        <p className={styles.empty}>{t('noItems')}</p>
      ) : (
        <ul className={styles.grid}>
          {items.map((item) => {
            const onHand = item.stock ? BigInt(item.stock.onHandMilli) : null;
            const out = onHand !== null && onHand <= 0n;
            const low = !out && item.stock?.toReorder === true;
            const look = lookOf(categoryOf(item.categoryId));
            const Icon = look.icon;
            const qty = onHand === null ? '' : formatQuantity(onHand).replace(/\.?0+$/, '');
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={cx(styles.prod, out && styles.prodOut)}
                  onClick={() => props.onAdd(item)}
                >
                  <span className={styles.prodHead}>
                    <Tile tone={look.tone}>
                      <Icon className={iconClass.sm} aria-hidden="true" />
                    </Tile>
                    {onHand !== null &&
                      (out ? (
                        <Chip tone="danger">{t('outOfStock')}</Chip>
                      ) : (
                        <Chip tone={low ? 'warn' : 'ok'}>
                          {t(low ? 'lowStock' : 'inStock', { qty })}
                        </Chip>
                      ))}
                  </span>
                  <strong className={styles.prodName}>{name(item)}</strong>
                  <span className={styles.code}>
                    <bdi>{item.code}</bdi>
                  </span>
                  <span className={styles.prodFoot}>
                    <span className={styles.price}>
                      <bdi>
                        {money(roundPrice(item.price!.price4dp))} <small>{t('currency')}</small>
                      </bdi>
                    </span>
                    <span className={styles.addMark} aria-hidden="true">
                      <Plus className={iconClass.sm} />
                    </span>
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
