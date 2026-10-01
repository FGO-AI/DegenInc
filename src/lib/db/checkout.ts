import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { requireMember, type SessionUser } from "@/lib/auth/guards";
import { MAX_LINES, MAX_QUANTITY, VARIANT_ID } from "@/lib/cart/limits";
import { adminDb } from "@/lib/firebase/admin";
import { isVisible, viewerOf } from "@/lib/visibility";

/**
 * Stock-reserving checkout, as one Firestore transaction.
 *
 * Firestore has nothing like SQL's CHECK (stock >= 0), so correctness comes from
 * the transaction instead. It reads every variant in the order and the product
 * each belongs to; decides, on those freshly read values, whether every line is
 * live, visible to this buyer and in stock; and only then writes — every
 * decrement and the order together, or nothing. Every read comes before any
 * write, as a transaction requires.
 *
 * Two buyers racing for the last shirt both read stock 1. Firestore's
 * serializable isolation will not let both commit: one is delayed or aborted
 * and the client library runs it again, and on that run it reads stock 0 and
 * refuses. So the stock check that counts is the one on the value read inside
 * the transaction — never a number read a moment earlier somewhere else. The
 * same goes for the filing: a filing that closed a moment ago is closed on the
 * read that decides.
 *
 * An order's lines live inside the order document (items), written in the same
 * transaction, so there is no separate order_items collection to keep in step.
 * Each keeps nameSnapshot and variantSnapshot: products get renamed and
 * repriced; orders do not.
 *
 * No certificate is issued here. A number is issued when an order is paid
 * (issueCertificate in functions/src/certificates.ts), so an unpaid order never
 * uses one up.
 */

export type OrderLine = { variantId: string; quantity: number };

/** Lines whose stock, read inside the transaction, is short of the quantity. */
export class OutOfStockError extends Error {
  constructor(variantIds: string[]) {
    super(`Out of stock: ${variantIds.join(", ")}`);
    this.name = "OutOfStockError";
  }
}

/**
 * Part of the order belongs to a filing that has closed. The stock sibling of
 * OutOfStockError, and handled the same way: nothing was written.
 */
export class FilingClosedError extends Error {
  constructor(variantIds: string[]) {
    super(`Filing closed: ${variantIds.join(", ")}`);
    this.name = "FilingClosedError";
  }
}

/**
 * Wrong before stock is ever consulted: no lines, too many, a malformed
 * quantity, a variant that does not exist, was never on sale, or is not yet on
 * sale to this buyer. Nothing is written.
 */
export class InvalidOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOrderError";
  }
}

/**
 * An order's lines, checked before anything is read or written.
 *
 * Untyped at runtime whatever the signature says — purchaseCart's arrive
 * straight from a browser. Lines for the same variant are merged, so an order
 * carries one line and one decrement per variant.
 */
function checkLines(items: unknown): OrderLine[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new InvalidOrderError("There is nothing in this order.");
  }
  if (items.length > MAX_LINES) {
    throw new InvalidOrderError(
      `An order can hold up to ${MAX_LINES} different items.`,
    );
  }

  const merged = new Map<string, number>();
  for (const item of items) {
    const { variantId, quantity } = (item ?? {}) as Record<string, unknown>;
    if (typeof variantId !== "string" || !VARIANT_ID.test(variantId)) {
      throw new InvalidOrderError("Something in this order is not sold here.");
    }
    if (
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      throw new InvalidOrderError(
        "Every quantity has to be a whole number, 1 or more.",
      );
    }
    merged.set(variantId, (merged.get(variantId) ?? 0) + quantity);
  }

  for (const quantity of merged.values()) {
    if (quantity > MAX_QUANTITY) {
      throw new InvalidOrderError(
        `An order can hold up to ${MAX_QUANTITY} of any one item.`,
      );
    }
  }

  return [...merged].map(([variantId, quantity]) => ({ variantId, quantity }));
}

/**
 * Write one order for `buyer`: the core both entry points below share.
 *
 * TRUSTS buyer. Not exported, and never an action — each caller has already
 * resolved the buyer from a session guard. It exists so that neither entry
 * point has to take a buyer from anywhere else.
 */
async function placeOrder(
  buyer: SessionUser,
  items: unknown,
): Promise<{ orderId: string }> {
  const lines = checkLines(items);
  const db = adminDb();
  const viewer = viewerOf(buyer);
  const orderRef = db.collection("orders").doc();

  await db.runTransaction(async (t) => {
    // ---- reads: every variant, then every product they belong to ----
    const variantRefs = lines.map((l) => db.doc(`variants/${l.variantId}`));
    const variantSnaps = await t.getAll(...variantRefs);
    const productIds = [
      ...new Set(variantSnaps.filter((v) => v.exists).map((v) => v.get("productId") as string)),
    ];
    const productSnaps = productIds.length
      ? await t.getAll(...productIds.map((id) => db.doc(`products/${id}`)))
      : [];
    const products = new Map(productSnaps.filter((p) => p.exists).map((p) => [p.id, p.data()!]));

    // ---- decide, on what was just read ----
    const closed: string[] = [];
    const short: string[] = [];
    const priced = lines.map((line, i) => {
      const variant = variantSnaps[i].data();
      const product = variant ? products.get(variant.productId) : undefined;
      const status = product?.filingStatus;
      if (!variant || !product || (status !== "live" && status !== "closed")) {
        // A draft or scheduled variant gets the same words as one that does
        // not exist: this must not confirm that an unreleased product is there.
        throw new InvalidOrderError("Something in this order is no longer sold.");
      }
      if (status === "closed") {
        closed.push(line.variantId);
      } else if (!isVisible(status, product, viewer)) {
        // Live, but not to this buyer yet — the same as not on sale at all.
        throw new InvalidOrderError("Something in this order is no longer sold.");
      } else if (variant.stock < line.quantity) {
        short.push(line.variantId);
      }
      return { line, ref: variantRefs[i], variant, product };
    });

    if (closed.length > 0) throw new FilingClosedError(closed);
    if (short.length > 0) throw new OutOfStockError(short);

    // ---- writes: every decrement and the order, or none of them ----
    for (const { line, ref, variant } of priced) {
      t.update(ref, {
        stock: variant.stock - line.quantity,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    const subtotal = priced.reduce((sum, { line, product }) => sum + product.priceCents * line.quantity, 0);
    t.create(orderRef, {
      memberId: buyer.id,
      status: "pending",
      items: priced.map(({ line, variant, product }) => ({
        variantId: line.variantId,
        productId: variant.productId,
        quantity: line.quantity,
        unitPriceCents: product.priceCents,
        nameSnapshot: product.name,
        variantSnapshot: `${variant.size} / ${variant.color}`,
      })),
      subtotalCents: subtotal,
      shippingCents: 0,
      totalCents: subtotal,
      currency: "usd",
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  return { orderId: orderRef.id };
}

/**
 * One variant, bought through the JSON endpoint at /api/checkout.
 *
 * Kept because that route — and scripts/concurrent-checkout.mjs behind it —
 * still calls it. It is a one-line order through the same core as
 * purchaseCart().
 *
 * It takes the buyer from its caller. That is safe only because its one caller
 * resolves the buyer with getSession() first and answers 401 itself. It must
 * never become reachable from a browser: no "use server" on this function, and
 * none at the top of this file.
 */
export async function purchaseVariant(opts: {
  buyer: SessionUser;
  variantId: string;
  quantity?: number;
}): Promise<{ orderId: string }> {
  const { buyer, variantId, quantity = 1 } = opts;
  return placeOrder(buyer, [{ variantId, quantity }]);
}

export type PurchaseResult =
  | { ok: true; orderId: string }
  | { ok: false; error: string };

/**
 * Buy everything in a bag, as one order. A SERVER ACTION.
 *
 * The buyer comes from requireMember(), on the first line, and from nowhere
 * else. There is deliberately no buyer parameter: anyone with the page open
 * can call an action with whatever arguments they like, so a buyer taken from
 * the caller would let them order as someone else. A signed-out caller is
 * redirected by the guard before anything below it runs.
 *
 * "use server" is inline, on this function alone. At the top of the file it
 * would also turn purchaseVariant() — which does trust its caller's buyer —
 * into a public endpoint, and it would fail the build besides: a "use server"
 * file may export only async functions, and this one exports error classes. A
 * client component cannot import an inline action, so the bag page, a Server
 * Component, passes this one to its client half as a prop — the documented way
 * to hand one over.
 *
 * Expected failures come back as { ok: false } instead of being thrown. In a
 * production build an error thrown by an action reaches the browser as a
 * generic message and a digest, so the bag page could not tell "this sold out
 * and nothing was ordered" from "something broke and the order may or may not
 * exist" — and a buyer needs to be told different things in each case.
 * Anything unexpected still throws.
 */
export async function purchaseCart(
  items: OrderLine[],
): Promise<PurchaseResult> {
  "use server";
  const buyer = await requireMember();

  try {
    const { orderId } = await placeOrder(buyer, items);
    return { ok: true, orderId };
  } catch (err) {
    if (err instanceof OutOfStockError) {
      return {
        ok: false,
        error:
          "Part of this order sold out while you were checking out, so none " +
          "of it went through. The lines that are short are marked below.",
      };
    }
    if (err instanceof FilingClosedError) {
      return {
        ok: false,
        error:
          "Part of this order is from a filing that has closed, so none of " +
          "it went through. Those lines are marked below.",
      };
    }
    if (err instanceof InvalidOrderError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
