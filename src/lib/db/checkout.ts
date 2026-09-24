import "server-only";

import { and, eq, exists, inArray, sql } from "drizzle-orm";
import { requireMember } from "@/lib/auth/guards";
import { MAX_LINES, MAX_QUANTITY, VARIANT_ID } from "@/lib/cart/limits";
import { getDb } from "./index";
import { filings, orderItems, orders, products, variants } from "./schema";

/**
 * Stock-reserving checkout.
 *
 * The shape of this function is dictated by two D1 facts:
 *
 * 1. There are no interactive transactions. `db.transaction(async tx => …)`
 *    throws. So we cannot read stock, decide, and then write inside one atomic
 *    unit — everything that must be atomic goes into a single `db.batch()`,
 *    which cannot branch partway through.
 *
 * 2. A conditional write is not a safety net. `UPDATE … WHERE stock >= 1` that
 *    matches nothing does NOT error; it updates zero rows, the batch commits
 *    happily, and we have sold a shirt we do not have.
 *
 * So the decrement is unconditional and `CHECK (stock >= 0)` on variants.stock
 * is what stops oversell. Going negative violates the constraint, the
 * statement errors, and D1 rolls the entire batch back — the order, every line
 * item and every decrement together. Under a drop-time stampede exactly one of
 * two racing buyers commits.
 *
 * An order with several lines changes none of this; the batch just gets
 * longer. One insert for the order, one per line item, one unconditional
 * decrement per line. If any single line would take its stock negative, the
 * whole batch rolls back — including the decrements of the lines that had
 * stock to spare. No partial orders, and nothing to clean up afterwards.
 *
 * Note the prices are read BEFORE the batch. That read can be served by a stale
 * replica, which is fine: it only determines what we charge, never whether
 * stock exists. The constraint decides that, on the primary.
 *
 * The same goes for whether the filing is still live. The read before the
 * batch refuses anything plainly not on sale, but a filing can close between
 * that read and the batch, so the decrement checks again, inside the batch: it
 * computes the new stock only while the variant's filing is live, and NULL
 * otherwise. `stock` is NOT NULL, so that statement fails and the whole batch
 * rolls back exactly as it does for oversell — a second constraint on the same
 * statement, not a second code path.
 */

export type OrderLine = { variantId: string; quantity: number };

/**
 * The constraint reports that a decrement went negative, not which one — so
 * this carries every variant in the order rather than guessing.
 */
export class OutOfStockError extends Error {
  constructor(variantIds: string[]) {
    super(`Out of stock: one or more of ${variantIds.join(", ")}`);
    this.name = "OutOfStockError";
  }
}

/**
 * Part of the order belongs to a filing that has closed. The stock sibling of
 * OutOfStockError, and handled the same way: nothing was written.
 *
 * Raised with the exact lines when the read before the batch sees the closure,
 * and with every line when the batch does (the constraint does not say which).
 */
export class FilingClosedError extends Error {
  constructor(variantIds: string[]) {
    super(`Filing closed: one or more of ${variantIds.join(", ")}`);
    this.name = "FilingClosedError";
  }
}

/**
 * Wrong before stock is ever consulted: no lines, a malformed quantity, a
 * variant that does not exist or was never on sale. Raised before the batch is
 * built, so nothing is written and no constraint is relied on to catch it.
 */
export class InvalidOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOrderError";
  }
}

/**
 * Which constraint stopped the batch, from the driver message. The batch is
 * not wrapped the way single statements are, so the message is SQLite's own.
 *
 * The closed-filing test comes first and is exact: its message also carries
 * SQLITE_CONSTRAINT, which the stock test below matches broadly.
 */
function refusal(err: unknown): "closed" | "stock" | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("NOT NULL constraint failed: variants.stock")) {
    return "closed";
  }
  if (
    message.includes("SQLITE_CONSTRAINT") ||
    message.includes("CHECK constraint failed") ||
    message.includes("variants_stock_non_negative")
  ) {
    return "stock";
  }
  return null;
}

/**
 * An order's lines, checked before anything is read or written.
 *
 * Untyped at runtime whatever the signature says — purchaseCart's arrive
 * straight from a browser. Lines for the same variant are merged, so an order
 * carries one line item and one decrement per variant.
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
 * Write one order for `userId`: the core both entry points below share.
 *
 * TRUSTS userId. Not exported, and never an action — each caller has already
 * resolved the buyer from a session guard. It exists so that neither entry
 * point has to take a buyer from anywhere else.
 */
async function placeOrder(
  userId: string,
  items: unknown,
): Promise<{ orderId: string }> {
  const lines = checkLines(items);
  const db = getDb();

  // Pre-batch read, one query for every line: the price, the names that go on
  // the receipt, and whether the filing is live. Never treated as proof that
  // stock exists, nor that the filing is still live by the time the batch runs.
  const priced = await db
    .select({
      variantId: variants.id,
      priceCents: products.priceCents,
      productName: products.name,
      size: variants.size,
      color: variants.color,
      // Left join: a product whose filing was deleted has none, and is not on
      // sale either.
      filingStatus: filings.status,
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(filings, eq(filings.id, products.filingId))
    .where(
      inArray(
        variants.id,
        lines.map((l) => l.variantId),
      ),
    );

  const byVariant = new Map(priced.map((p) => [p.variantId, p]));
  const closed: string[] = [];
  const pricedLines = lines.map((line) => {
    const row = byVariant.get(line.variantId);
    // Rejected here, before a batch exists, rather than left for a foreign key
    // inside it to fail. A draft or scheduled variant gets the same words as
    // one that does not exist: this must not confirm that an unreleased
    // product is there.
    if (!row || (row.filingStatus !== "live" && row.filingStatus !== "closed")) {
      throw new InvalidOrderError("Something in this order is no longer sold.");
    }
    if (row.filingStatus === "closed") closed.push(line.variantId);
    return { ...line, ...row };
  });

  if (closed.length > 0) throw new FilingClosedError(closed);

  const orderId = crypto.randomUUID();
  const subtotal = pricedLines.reduce(
    (sum, line) => sum + line.priceCents * line.quantity,
    0,
  );

  // True while the variant being decremented belongs to a live filing. It is
  // correlated to the row the UPDATE is on — "variants"."product_id" inside the
  // subquery is the outer statement's — so it is read inside the batch, on the
  // primary, at the moment of the write.
  const onLiveFiling = exists(
    db
      .select({ one: sql`1` })
      .from(products)
      .innerJoin(filings, eq(filings.id, products.filingId))
      .where(
        and(eq(products.id, variants.productId), eq(filings.status, "live")),
      ),
  );

  try {
    await db.batch([
      db.insert(orders).values({
        id: orderId,
        userId,
        status: "pending",
        subtotalCents: subtotal,
        shippingCents: 0,
        totalCents: subtotal,
      }),
      ...pricedLines.map((line) =>
        db.insert(orderItems).values({
          id: crypto.randomUUID(),
          orderId,
          variantId: line.variantId,
          quantity: line.quantity,
          unitPriceCents: line.priceCents,
          nameSnapshot: line.productName,
          variantSnapshot: `${line.size} / ${line.color}`,
        }),
      ),
      // Unconditional on purpose, one per line: never a WHERE that could match
      // nothing and let the batch commit. See the comment at the top of this
      // file. Two constraints decide it — CHECK (stock >= 0) for oversell, and
      // NOT NULL for a filing that is no longer live, since the CASE yields
      // NULL then.
      ...pricedLines.map((line) =>
        db
          .update(variants)
          .set({
            stock: sql`CASE WHEN ${onLiveFiling} THEN ${variants.stock} - ${line.quantity} END`,
          })
          .where(eq(variants.id, line.variantId)),
      ),
    ]);
  } catch (err) {
    const ids = pricedLines.map((l) => l.variantId);
    switch (refusal(err)) {
      case "closed":
        throw new FilingClosedError(ids);
      case "stock":
        throw new OutOfStockError(ids);
    }
    throw err;
  }

  return { orderId };
}

/**
 * One variant, bought through the JSON endpoint at /api/checkout.
 *
 * Kept because that route — and scripts/concurrent-checkout.mjs behind it —
 * still calls it. It is now a one-line order through the same core as
 * purchaseCart().
 *
 * It takes userId from its caller. That is safe only because its one caller
 * resolves the buyer with getSession() first and answers 401 itself. It must
 * never become reachable from a browser: no "use server" on this function, and
 * none at the top of this file.
 */
export async function purchaseVariant(opts: {
  userId: string;
  variantId: string;
  quantity?: number;
}): Promise<{ orderId: string }> {
  const { userId, variantId, quantity = 1 } = opts;
  return placeOrder(userId, [{ variantId, quantity }]);
}

export type PurchaseResult =
  | { ok: true; orderId: string }
  | { ok: false; error: string };

/**
 * Buy everything in a bag, as one order. A SERVER ACTION.
 *
 * The buyer comes from requireMember(), on the first line, and from nowhere
 * else. There is deliberately no userId parameter: anyone with the page open
 * can call an action with whatever arguments they like, so a buyer id taken
 * from the caller would let them order as someone else. A signed-out caller is
 * redirected by the guard before anything below it runs.
 *
 * "use server" is inline, on this function alone. At the top of the file it
 * would also turn purchaseVariant() — which does trust a caller's userId — into
 * a public endpoint, and it would fail the build besides: a "use server" file
 * may export only async functions, and this one exports error classes. A
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
  const user = await requireMember();

  try {
    const { orderId } = await placeOrder(user.id, items);
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
