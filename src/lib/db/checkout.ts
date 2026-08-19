import "server-only";

import { eq, sql } from "drizzle-orm";
import { getDb } from "./index";
import { orderItems, orders, variants } from "./schema";

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
 * statement errors, and D1 rolls the entire batch back — order, line item and
 * decrement together. Under a drop-time stampede exactly one of two racing
 * buyers commits.
 *
 * Note the price is read BEFORE the batch. That read can be served by a stale
 * replica, which is fine: it only determines what we charge, never whether
 * stock exists. The constraint decides that, on the primary.
 */

export class OutOfStockError extends Error {
  constructor(variantId: string) {
    super(`Variant ${variantId} is out of stock`);
    this.name = "OutOfStockError";
  }
}

/** SQLite reports a violated CHECK through the driver message. */
function isConstraintViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("SQLITE_CONSTRAINT") ||
    message.includes("CHECK constraint failed") ||
    message.includes("variants_stock_non_negative")
  );
}

export async function purchaseVariant(opts: {
  userId: string;
  variantId: string;
  quantity?: number;
}): Promise<{ orderId: string }> {
  const { userId, variantId, quantity = 1 } = opts;
  const db = getDb();

  // Pre-batch read: pricing only. Never treated as proof that stock exists.
  const [row] = await db
    .select({
      variantId: variants.id,
      priceCents: sql<number>`(SELECT price_cents FROM products WHERE products.id = ${variants.productId})`,
      productName: sql<string>`(SELECT name FROM products WHERE products.id = ${variants.productId})`,
    })
    .from(variants)
    .where(eq(variants.id, variantId))
    .limit(1);

  if (!row) throw new Error(`Unknown variant ${variantId}`);

  const orderId = crypto.randomUUID();
  const subtotal = row.priceCents * quantity;

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
      db.insert(orderItems).values({
        id: crypto.randomUUID(),
        orderId,
        variantId,
        quantity,
        unitPriceCents: row.priceCents,
        nameSnapshot: row.productName,
      }),
      // Unconditional on purpose. See the comment at the top of this file.
      db
        .update(variants)
        .set({ stock: sql`${variants.stock} - ${quantity}` })
        .where(eq(variants.id, variantId)),
    ]);
  } catch (err) {
    if (isConstraintViolation(err)) throw new OutOfStockError(variantId);
    throw err;
  }

  return { orderId };
}
