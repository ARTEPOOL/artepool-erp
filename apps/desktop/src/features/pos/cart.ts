/**
 * The POS cart (decisions 0005, 0059): lines built on the same editor model and preview as the A4
 * invoice, the customer (the cash customer by default), and the lines removed before payment, which
 * go to the server with the sale and into the audit log. The cart lives in memory on this screen
 * only; it survives moving to the shift screen and back, and a held cart is kept on the server.
 */
import { useSyncExternalStore } from 'react';
import { formatQuantity, parseQuantity } from '@artepool/shared';
import type { CartRemoval, ItemListItem } from '@artepool/shared/contracts';
import type { ChosenCustomer } from '../sales/CustomerPicker';
import { lineFromItem, type EditorLine } from '../sales/lines';

export interface Cart {
  cartId: string;
  customer: ChosenCustomer | null;
  lines: EditorLine[];
  removals: CartRemoval[];
  heldCartId: string | null;
}

export const emptyCart = (): Cart => ({
  cartId: crypto.randomUUID(),
  customer: null,
  lines: [],
  removals: [],
  heldCartId: null,
});

/** Thousandths of a typed quantity, 0 when it cannot be read. */
const milli = (text: string): bigint => {
  try {
    return parseQuantity(text.trim() === '' ? '0' : text.trim());
  } catch {
    return 0n;
  }
};
const quantityText = (m: bigint) => formatQuantity(m).replace(/\.?0+$/, '');

/** Scanning or tapping the same item again adds one to its line (same price, no discount). */
export function addItem(cart: Cart, item: ItemListItem): Cart {
  const same = cart.lines.find(
    (l) => l.itemId === item.id && l.unitPrice === '' && l.discount.trim() === '',
  );
  if (same) {
    return setQuantity(cart, same.key, quantityText(milli(same.quantity) + 1000n));
  }
  return { ...cart, lines: [...cart.lines, lineFromItem(item)] };
}

/** A smaller quantity counts as a removal of the difference (decision 0005). */
export function setQuantity(cart: Cart, key: string, quantity: string, at = new Date()): Cart {
  const line = cart.lines.find((l) => l.key === key);
  if (!line) return cart;
  const before = milli(line.quantity);
  const after = milli(quantity);
  const removals =
    after < before && after > 0n
      ? [...cart.removals, removal(line.itemId, before - after, at)]
      : cart.removals;
  return {
    ...cart,
    removals,
    lines: cart.lines.map((l) => (l.key === key ? { ...l, quantity } : l)),
  };
}

const removal = (itemId: string, quantity: bigint, at: Date): CartRemoval => ({
  itemId,
  quantityMilli: quantity.toString(),
  removedAt: at.toISOString(),
});

export function removeLine(cart: Cart, key: string, at = new Date()): Cart {
  const line = cart.lines.find((l) => l.key === key);
  if (!line) return cart;
  const q = milli(line.quantity);
  return {
    ...cart,
    lines: cart.lines.filter((l) => l.key !== key),
    removals: q > 0n ? [...cart.removals, removal(line.itemId, q, at)] : cart.removals,
  };
}

/** The − / + buttons: one more or one less; the last one removes the line. */
export function stepQuantity(cart: Cart, key: string, step: 1 | -1, at = new Date()): Cart {
  const line = cart.lines.find((l) => l.key === key);
  if (!line) return cart;
  const next = milli(line.quantity) + BigInt(step) * 1000n;
  return next <= 0n ? removeLine(cart, key, at) : setQuantity(cart, key, quantityText(next), at);
}

export function updateLine(cart: Cart, key: string, patch: Partial<EditorLine>): Cart {
  return { ...cart, lines: cart.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) };
}

/** Emptying the cart before payment is a removal of every line. */
export function clearCart(cart: Cart, at = new Date()): Cart {
  return cart.lines.reduce((c, l) => removeLine(c, l.key, at), cart);
}

// ---------------------------------------------------------------------------------------------
// The cart of this screen (kept while the app runs)
// ---------------------------------------------------------------------------------------------

let current: Cart = emptyCart();
const listeners = new Set<() => void>();

export const cartStore = {
  get: (): Cart => current,
  set: (next: Cart | ((cart: Cart) => Cart)): void => {
    current = typeof next === 'function' ? next(current) : next;
    for (const listener of listeners) listener();
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  reset: (): void => cartStore.set(emptyCart()),
};

export function useCart(): Cart {
  return useSyncExternalStore(cartStore.subscribe, cartStore.get);
}
