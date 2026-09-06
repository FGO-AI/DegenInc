import "server-only";

import { connection } from "next/server";
import { asc, count, desc, eq, inArray } from "drizzle-orm";
import { requireMember, type SessionUser } from "@/lib/auth/guards";
import { getDb } from "./index";
import {
  certificates,
  filings,
  orderItems,
  orders,
  products,
  variants,
  votes,
} from "./schema";

/**
 * Server-only data access layer.
 *
 * Under Supabase, RLS meant the database itself refused to return rows the
 * caller should not see, so a leaked query was still safe. D1 has no such
 * thing: it returns whatever it is asked for. Authorization is therefore
 * application code, and it lives here.
 *
 * The rule for this file: every function that touches member or staff data
 * calls a guard from src/lib/auth/guards.ts FIRST. Functions that are
 * genuinely public — the live filing, a product page — say so in a comment,
 * so "no guard" is always a decision rather than an oversight.
 */

export type FilingSlot = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  priceCents: number;
  /** Sum of stock across every variant. 0 means sold out. */
  stock: number;
};

/**
 * PUBLIC BY DESIGN. The live filing and its products are the storefront;
 * anyone can read them, signed in or not.
 *
 * Note this reads through D1 read replicas, which can serve slightly stale
 * data. That is fine for displaying stock on a grid. It is NOT fine for the
 * checkout write path, which must go through the primary and rely on the
 * stock CHECK constraint rather than on a number it read a moment ago.
 */
export async function getLiveFiling() {
  // Excludes the storefront from prerendering.
  //
  // Without this the page is rendered at BUILD time, where no D1 binding
  // exists — getLiveFilingSafe() swallows the failure, and the "awaiting
  // asset" placeholders get baked into a static page that then serves
  // forever, whatever the database actually holds. Stock counts have to be
  // read per request.
  await connection();

  const db = getDb();

  const [filing] = await db
    .select()
    .from(filings)
    .where(eq(filings.status, "live"))
    .orderBy(asc(filings.number))
    .limit(1);

  if (!filing) return null;

  const rows = await db
    .select()
    .from(products)
    .where(eq(products.filingId, filing.id))
    .orderBy(asc(products.position));

  if (rows.length === 0) return { filing, slots: [] as FilingSlot[] };

  // One extra query rather than N: fetch every variant for these products and
  // total the stock in memory.
  const variantRows = await db
    .select({
      productId: variants.productId,
      stock: variants.stock,
    })
    .from(variants)
    .where(
      inArray(
        variants.productId,
        rows.map((p) => p.id),
      ),
    );

  const stockByProduct = new Map<string, number>();
  for (const v of variantRows) {
    stockByProduct.set(v.productId, (stockByProduct.get(v.productId) ?? 0) + v.stock);
  }

  const slots: FilingSlot[] = rows.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    priceCents: p.priceCents,
    stock: stockByProduct.get(p.id) ?? 0,
  }));

  return { filing, slots };
}

/**
 * Same as getLiveFiling, but never throws.
 *
 * The storefront is prerendered at build time, where no D1 binding exists, and
 * it must also render on a machine that has not run migrations yet. In both
 * cases the page falls back to the "awaiting asset" placeholder slots, which
 * is the correct pre-launch design anyway.
 */
export async function getLiveFilingSafe() {
  try {
    return await getLiveFiling();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------
   Member record
   ------------------------------------------------------------------------- */

/** Orders shown on the record. A member page is not a paginated ledger. */
const ORDER_LIMIT = 50;

export type MemberOrderLine = {
  name: string;
  quantity: number;
  unitPriceCents: number;
};

export type MemberOrder = {
  id: string;
  status: "pending" | "paid" | "fulfilled" | "cancelled" | "refunded";
  totalCents: number;
  placedAt: Date;
  lines: MemberOrderLine[];
};

/** Null until issuance exists. Nothing writes to `certificates` yet. */
export type MemberCertificate = {
  number: number;
  class: string;
  issuedAt: Date;
} | null;

export type MemberRecord = {
  user: SessionUser;
  certificate: MemberCertificate;
  orders: MemberOrder[];
  votesCast: number;
};

/**
 * Everything /account renders for the signed-in member.
 *
 * GUARDED. requireMember() runs first and the user id comes from the verified
 * session — never from a parameter, because there is no parameter. Under RLS a
 * leaked id was survivable; here it would just hand back someone else's orders.
 *
 * Note the projections are explicit rather than a select(). Whatever a server
 * component returns is serialised into the RSC payload and shipped to the
 * browser, and select() on `orders` would put stripePaymentIntentId and the
 * shippingAddress JSON in there. Neither is rendered; neither should leave the
 * worker.
 *
 * Two round trips, not four: the first three reads are independent, so they go
 * in one db.batch(). Line items need the order ids, so they follow. A batch
 * also runs against the primary rather than a read replica, which is what we
 * want anyway — a member who just checked out must see their own order.
 */
export async function getMemberRecord(): Promise<MemberRecord> {
  // Guard before any query, per the rule at the top of this file. This also
  // calls connection() transitively, so the route stays out of the prerender.
  const me = await requireMember();

  const db = getDb();

  const [certRows, orderRows, voteRows] = await db.batch([
    // certificates.userId is UNIQUE — at most one per member, forever.
    db
      .select({
        number: certificates.number,
        class: certificates.class,
        issuedAt: certificates.issuedAt,
      })
      .from(certificates)
      .where(eq(certificates.userId, me.id))
      .limit(1),

    // `currency` is deliberately not selected. money() hardcodes $ and en-US,
    // so carrying a currency column we then ignore is how a euro amount ends
    // up printed with a dollar sign.
    db
      .select({
        id: orders.id,
        status: orders.status,
        totalCents: orders.totalCents,
        placedAt: orders.createdAt,
      })
      .from(orders)
      .where(eq(orders.userId, me.id))
      .orderBy(desc(orders.createdAt))
      .limit(ORDER_LIMIT),

    db.select({ n: count() }).from(votes).where(eq(votes.userId, me.id)),
  ]);

  // One extra query rather than N, same shape as getLiveFiling above. Skipped
  // entirely when there is nothing to look up — inArray over an empty list is
  // a query with no useful answer.
  const lineRows = orderRows.length
    ? await db
        .select({
          orderId: orderItems.orderId,
          name: orderItems.nameSnapshot,
          quantity: orderItems.quantity,
          unitPriceCents: orderItems.unitPriceCents,
        })
        .from(orderItems)
        .where(
          inArray(
            orderItems.orderId,
            orderRows.map((o) => o.id),
          ),
        )
        // Otherwise SQLite returns rowid order, which is insertion order and
        // therefore an implementation detail.
        .orderBy(asc(orderItems.nameSnapshot))
    : [];

  const linesByOrder = new Map<string, MemberOrderLine[]>();
  for (const row of lineRows) {
    const line = {
      name: row.name,
      quantity: row.quantity,
      unitPriceCents: row.unitPriceCents,
    };
    const list = linesByOrder.get(row.orderId);
    if (list) list.push(line);
    else linesByOrder.set(row.orderId, [line]);
  }

  return {
    user: me,
    certificate: certRows[0] ?? null,
    orders: orderRows.map((o) => ({
      ...o,
      lines: linesByOrder.get(o.id) ?? [],
    })),
    votesCast: voteRows[0]?.n ?? 0,
  };
}
