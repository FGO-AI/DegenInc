"use client";

import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { MAX_LINES, MAX_QUANTITY, VARIANT_ID } from "./limits";

/**
 * The bag: which variants someone picked, and how many. Nothing else.
 *
 * No price, no name, no stock. Those belong to the product, and they change —
 * a price cached here is a price that was true when the item went in, which is
 * not what anyone should be shown at checkout. The bag page asks for current
 * details every time it renders (getCartDetails), and checkout prices from the
 * database, never from anything the client holds.
 *
 * Kept in localStorage so a refresh keeps it. Every read and write is wrapped:
 * storage can be disabled, blocked or full, and a bag that cannot persist
 * should degrade to one that lasts the page, not take the app down.
 *
 * The store is a module-level snapshot read through useSyncExternalStore
 * rather than useState filled in by an effect. That is React's tool for state
 * that lives outside it; it gives every subscriber the same value in the same
 * render, so the masthead count cannot lag the bag page; and it hydrates
 * against an empty server snapshot, so the server and client render agree.
 * The module state is only ever written by browser event handlers, so on the
 * server it stays empty and is never shared between requests.
 */

export type CartItem = { variantId: string; quantity: number };

const KEY = "degen:bag";
const EMPTY: readonly CartItem[] = [];

let snapshot: readonly CartItem[] | null = null;
const listeners = new Set<() => void>();

/** Whatever was stored, reduced to well-formed lines, one per variant. */
function normalise(value: unknown): CartItem[] {
  if (!Array.isArray(value)) return [];
  const merged = new Map<string, number>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { variantId, quantity } = entry as Record<string, unknown>;
    if (typeof variantId !== "string" || !VARIANT_ID.test(variantId)) continue;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
      continue;
    }
    merged.set(
      variantId,
      Math.min(MAX_QUANTITY, (merged.get(variantId) ?? 0) + quantity),
    );
  }
  return [...merged]
    .slice(0, MAX_LINES)
    .map(([variantId, quantity]) => ({ variantId, quantity }));
}

function load(): readonly CartItem[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? normalise(JSON.parse(raw)) : EMPTY;
  } catch {
    // Unavailable storage, or something unparseable under our key.
    return EMPTY;
  }
}

function getSnapshot(): readonly CartItem[] {
  return (snapshot ??= load());
}

function getServerSnapshot(): readonly CartItem[] {
  return EMPTY;
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  // Another tab changed the bag. Drop the cached copy so the next read picks
  // up theirs; `key === null` is a storage.clear().
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return;
    snapshot = null;
    listener();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function commit(next: readonly CartItem[]) {
  snapshot = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Full or blocked. The in-memory copy still holds for this page.
  }
  for (const listener of listeners) listener();
}

const clamp = (n: number) => Math.min(MAX_QUANTITY, Math.max(1, Math.floor(n)));

/** Add to a line, or start one. Quietly ignored past MAX_LINES distinct variants. */
function addItem(variantId: string, quantity = 1) {
  if (!VARIANT_ID.test(variantId) || !(quantity >= 1)) return;
  const items = getSnapshot();
  const line = items.find((i) => i.variantId === variantId);
  if (line) {
    setQuantity(variantId, line.quantity + quantity);
  } else if (items.length < MAX_LINES) {
    commit([...items, { variantId, quantity: clamp(quantity) }]);
  }
}

function removeItem(variantId: string) {
  commit(getSnapshot().filter((i) => i.variantId !== variantId));
}

/** Set a line to exactly this many. Zero or less removes it. */
function setQuantity(variantId: string, quantity: number) {
  if (!(quantity >= 1)) return removeItem(variantId);
  commit(
    getSnapshot().map((i) =>
      i.variantId === variantId ? { ...i, quantity: clamp(quantity) } : i,
    ),
  );
}

function clear() {
  commit(EMPTY);
}

// Hydration marker: false on the server and during hydration, true after.
const noop = () => () => {};
const onClient = () => true;
const onServer = () => false;

type CartValue = {
  items: readonly CartItem[];
  /** Total units across every line — the masthead badge. */
  count: number;
  /**
   * False until the stored bag has been read in the browser. Until then
   * `items` is the empty server snapshot, and "your bag is empty" would be a
   * lie rather than a fact.
   */
  ready: boolean;
  addItem: (variantId: string, quantity?: number) => void;
  removeItem: (variantId: string) => void;
  setQuantity: (variantId: string, quantity: number) => void;
  clear: () => void;
};

const CartContext = createContext<CartValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const items = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const ready = useSyncExternalStore(noop, onClient, onServer);

  const value = useMemo<CartValue>(
    () => ({
      items,
      count: items.reduce((n, i) => n + i.quantity, 0),
      ready,
      addItem,
      removeItem,
      setQuantity,
      clear,
    }),
    [items, ready],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const value = useContext(CartContext);
  if (!value) throw new Error("useCart() needs a <CartProvider> above it.");
  return value;
}
