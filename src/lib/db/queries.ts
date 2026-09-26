import "server-only";

import { connection } from "next/server";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import {
  requireMember,
  requireStaff,
  type SessionUser,
} from "@/lib/auth/guards";
import { MAX_LINES, VARIANT_ID } from "@/lib/cart/limits";
import { getDb } from "./index";
import {
  certificates,
  filings,
  orderItems,
  orders,
  productImages,
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
  /**
   * R2 key of the primary image (position 0), served at /images/<key>. Null
   * until one is uploaded; the grid shows its text placeholder instead.
   */
  imageKey: string | null;
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

  const productIds = rows.map((p) => p.id);

  // One extra query each rather than N: every variant for these products, to
  // total the stock in memory, and every primary image. Both depend only on
  // the product ids, so they run side by side rather than one after the other.
  const [variantRows, imageRows] = await Promise.all([
    db
      .select({
        productId: variants.productId,
        stock: variants.stock,
      })
      .from(variants)
      .where(inArray(variants.productId, productIds)),

    db
      .select({
        productId: productImages.productId,
        r2Key: productImages.r2Key,
      })
      .from(productImages)
      .where(
        and(
          inArray(productImages.productId, productIds),
          eq(productImages.position, 0),
        ),
      ),
  ]);

  const stockByProduct = new Map<string, number>();
  for (const v of variantRows) {
    stockByProduct.set(v.productId, (stockByProduct.get(v.productId) ?? 0) + v.stock);
  }

  // Two uploads landing at the same instant can both take position 0 (see
  // uploadProductImage). Keep the first one seen rather than letting the last
  // overwrite it; either is a real photo of the product.
  const imageByProduct = new Map<string, string>();
  for (const img of imageRows) {
    if (!imageByProduct.has(img.productId)) {
      imageByProduct.set(img.productId, img.r2Key);
    }
  }

  const slots: FilingSlot[] = rows.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    priceCents: p.priceCents,
    stock: stockByProduct.get(p.id) ?? 0,
    imageKey: imageByProduct.get(p.id) ?? null,
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
   A product page
   ------------------------------------------------------------------------- */

/** One size/color combination and what is left of it. */
export type ProductVariant = {
  id: string;
  size: string;
  color: string;
  stock: number;
};

export type ProductImage = {
  /** R2 object key, served at /images/<key>. */
  key: string;
  alt: string | null;
};

export type ProductPage = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  description: string | null;
  priceCents: number;
  filingNumber: number;
  /** Ordered by position; the first is the primary shot on the grid. */
  images: ProductImage[];
  /** Every combination separately, in the order staff entered them. */
  variants: ProductVariant[];
};

/**
 * PUBLIC BY DESIGN, for the same reason as getLiveFiling: a product on the
 * live filing is the storefront.
 *
 * Null unless the product's filing is live, which the query decides rather
 * than a check afterwards — a draft, scheduled or closed product, or one whose
 * filing was deleted, matches nothing. The page turns null into a 404, so an
 * unreleased slug looks exactly like one that was never used.
 *
 * Variants come back unsummed. getLiveFiling totals them because the grid only
 * says "3 left"; a size picker has to know that M / Black is gone while
 * L / Black is not.
 *
 * Explicit projections, as everywhere a result reaches a page: the variants
 * are handed to a client component, so whatever is selected here is in the
 * browser. SKUs are staff business and stay behind.
 *
 * Replica-served, so stock can be a moment stale — fine for a picker. The bag
 * page re-reads it, and checkout's constraints decide.
 */
export async function getProductBySlug(
  slug: string,
): Promise<ProductPage | null> {
  // Request-time read — see getLiveFiling() for why this has to come first.
  await connection();

  const db = getDb();

  const [product] = await db
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      kind: products.kind,
      description: products.description,
      priceCents: products.priceCents,
      filingNumber: filings.number,
    })
    .from(products)
    .innerJoin(filings, eq(filings.id, products.filingId))
    .where(and(eq(products.slug, slug), eq(filings.status, "live")))
    .limit(1);

  if (!product) return null;

  // Both depend only on the product id, so they go side by side, as in
  // getLiveFiling.
  const [variantRows, imageRows] = await Promise.all([
    db
      .select({
        id: variants.id,
        size: variants.size,
        color: variants.color,
        stock: variants.stock,
      })
      .from(variants)
      .where(eq(variants.productId, product.id))
      .orderBy(asc(variants.createdAt)),

    db
      .select({ key: productImages.r2Key, alt: productImages.alt })
      .from(productImages)
      .where(eq(productImages.productId, product.id))
      .orderBy(asc(productImages.position)),
  ]);

  return { ...product, images: imageRows, variants: variantRows };
}

/* -------------------------------------------------------------------------
   The bag
   ------------------------------------------------------------------------- */

/** A line the bag can show: its filing is live, or was and has since closed. */
export type CartLineDetail = {
  variantId: string;
  /**
   * True while the filing is live. False once it has closed: the buyer still
   * sees what they picked, but it cannot be ordered.
   */
  available: boolean;
  productName: string;
  size: string;
  color: string;
  priceCents: number;
  stock: number;
};

/**
 * Anything else — a variant whose filing was never published, or no such
 * variant at all. Nothing to show but the id that was asked about.
 */
export type CartLineHidden = { variantId: string; available: false };

export type CartLine = CartLineDetail | CartLineHidden;

/**
 * PUBLIC BY DESIGN, for the same reason as getLiveFiling: a price and a stock
 * count are what the storefront already shows anyone. Looking at your own bag
 * needs no account.
 *
 * The bag in the browser holds only variant ids and quantities
 * (src/lib/cart/CartProvider.tsx), so this is where it learns what they are
 * *now* — today's price, today's stock — rather than what was true when each
 * went in.
 *
 * Public stops at what has been public. A variant on a live filing comes back
 * in full. One on a closed filing was on sale once, so it still comes back in
 * full, marked unavailable — whoever had it in their bag when the drop ended
 * can see what it was. Anything else, draft and scheduled filings included,
 * comes back as a bare { variantId, available: false }: no name, no price.
 * An id that matches nothing gets that same bare row rather than being left
 * out, so the answer cannot be used to find out which unreleased ids exist.
 *
 * Replica-served, like getLiveFiling, so stock or status can be a moment
 * stale. That is fine for showing someone what is wrong with their bag. It is
 * not what decides the order: checkout's constraints do, on the primary.
 *
 * The input is whatever a browser sent, so it is filtered to well-formed ids
 * and capped before it reaches the query. One line comes back per id kept.
 */
export async function getCartDetails(variantIds: string[]): Promise<CartLine[]> {
  // Request-time read — see getLiveFiling() for why this has to come first.
  await connection();

  const ids = [...new Set(variantIds)]
    .filter((id) => typeof id === "string" && VARIANT_ID.test(id))
    .slice(0, MAX_LINES);
  if (ids.length === 0) return [];

  const rows = await getDb()
    .select({
      variantId: variants.id,
      productName: products.name,
      size: variants.size,
      color: variants.color,
      priceCents: products.priceCents,
      stock: variants.stock,
      // Left join: a product whose filing was deleted has none, and gets the
      // bare row below like any other never-public variant.
      status: filings.status,
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(filings, eq(filings.id, products.filingId))
    .where(inArray(variants.id, ids));

  const byId = new Map(rows.map((r) => [r.variantId, r]));

  return ids.map((variantId): CartLine => {
    const row = byId.get(variantId);
    if (!row || (row.status !== "live" && row.status !== "closed")) {
      return { variantId, available: false };
    }
    const { status, ...line } = row;
    return { ...line, available: status === "live" };
  });
}

/* -------------------------------------------------------------------------
   Member record
   ------------------------------------------------------------------------- */

/** Orders shown on the record. A member page is not a paginated ledger. */
const ORDER_LIMIT = 50;

export type MemberOrderLine = {
  name: string;
  /** "M / Black". Null on lines written before variant_snapshot existed. */
  variant: string | null;
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
          variant: orderItems.variantSnapshot,
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
        // therefore an implementation detail. The variant breaks ties between
        // two sizes of the same product.
        .orderBy(asc(orderItems.nameSnapshot), asc(orderItems.variantSnapshot))
    : [];

  const linesByOrder = new Map<string, MemberOrderLine[]>();
  for (const row of lineRows) {
    const line = {
      name: row.name,
      variant: row.variant,
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

/* -------------------------------------------------------------------------
   Back of house: the catalogue
   ------------------------------------------------------------------------- */

export type FilingStatus = (typeof filings.status.enumValues)[number];

export type AdminVariant = {
  id: string;
  size: string;
  color: string;
  sku: string;
  stock: number;
};

export type AdminImage = {
  id: string;
  /** R2 object key. The URL is /images/<key>, built where it is rendered. */
  r2Key: string;
};

export type AdminProduct = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  priceCents: number;
  variants: AdminVariant[];
  images: AdminImage[];
};

export type AdminFiling = {
  id: string;
  number: number;
  title: string;
  status: FilingStatus;
  products: AdminProduct[];
};

/** Filings shown in the console. Fifty drops is years of back catalogue. */
const FILING_LIMIT = 50;

/**
 * Every filing the console manages, each with its products, their variants and
 * their images. The same shapes come back from the actions in ./admin.ts, so
 * the console can splice a created row straight into what it already holds.
 *
 * GUARDED. requireStaff() runs before any query.
 *
 * connection() comes first, and explicitly, even though getSession() calls it
 * too: this is a request-time read, and keeping it out of the prerender must
 * not hinge on what a guard happens to do internally. getLiveFiling() says why
 * that matters.
 *
 * One round trip. Products, variants and images are scoped by subqueries over
 * the same window of filings rather than by ids read first, so all four reads
 * are independent and go in one db.batch() — which runs on the primary, so a
 * filing created a moment ago is there on reload.
 *
 * Images come back as keys rather than a count: the count is the list's
 * length, and the keys are what let the console show the thumbnails.
 */
export async function getAdminCatalog(): Promise<AdminFiling[]> {
  await connection();
  await requireStaff();

  const db = getDb();

  const recentFilings = db
    .select({ id: filings.id })
    .from(filings)
    .orderBy(desc(filings.number))
    .limit(FILING_LIMIT);

  const theirProducts = db
    .select({ id: products.id })
    .from(products)
    .where(inArray(products.filingId, recentFilings));

  const [filingRows, productRows, variantRows, imageRows] = await db.batch([
    db
      .select({
        id: filings.id,
        number: filings.number,
        title: filings.title,
        status: filings.status,
      })
      .from(filings)
      .orderBy(desc(filings.number))
      .limit(FILING_LIMIT),

    db
      .select({
        id: products.id,
        filingId: products.filingId,
        slug: products.slug,
        name: products.name,
        kind: products.kind,
        priceCents: products.priceCents,
      })
      .from(products)
      .where(inArray(products.filingId, recentFilings))
      .orderBy(asc(products.position), asc(products.createdAt)),

    db
      .select({
        id: variants.id,
        productId: variants.productId,
        size: variants.size,
        color: variants.color,
        sku: variants.sku,
        stock: variants.stock,
      })
      .from(variants)
      .where(inArray(variants.productId, theirProducts))
      .orderBy(asc(variants.createdAt)),

    db
      .select({
        id: productImages.id,
        productId: productImages.productId,
        r2Key: productImages.r2Key,
      })
      .from(productImages)
      .where(inArray(productImages.productId, theirProducts))
      .orderBy(asc(productImages.position)),
  ]);

  const variantsByProduct = new Map<string, AdminVariant[]>();
  for (const { productId, ...variant } of variantRows) {
    const list = variantsByProduct.get(productId);
    if (list) list.push(variant);
    else variantsByProduct.set(productId, [variant]);
  }

  const imagesByProduct = new Map<string, AdminImage[]>();
  for (const { productId, ...image } of imageRows) {
    const list = imagesByProduct.get(productId);
    if (list) list.push(image);
    else imagesByProduct.set(productId, [image]);
  }

  const productsByFiling = new Map<string, AdminProduct[]>();
  for (const { filingId, ...product } of productRows) {
    // Only null when a filing was deleted out from under it (ON DELETE SET
    // NULL), and the subquery already excludes those.
    if (!filingId) continue;
    const row = {
      ...product,
      variants: variantsByProduct.get(product.id) ?? [],
      images: imagesByProduct.get(product.id) ?? [],
    };
    const list = productsByFiling.get(filingId);
    if (list) list.push(row);
    else productsByFiling.set(filingId, [row]);
  }

  return filingRows.map((f) => ({
    ...f,
    products: productsByFiling.get(f.id) ?? [],
  }));
}
