import "server-only";

import { connection } from "next/server";
import { Timestamp, type DocumentData, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import {
  getSession,
  requireMember,
  requireStaff,
  type SessionUser,
} from "@/lib/auth/guards";
import { MAX_LINES, VARIANT_ID } from "@/lib/cart/limits";
import { adminDb } from "@/lib/firebase/admin";
import { isVisible, viewerOf } from "@/lib/visibility";

/**
 * Server-only data access layer.
 *
 * Everything here reads Firestore through the Admin SDK, which BYPASSES
 * firestore.rules: the database will hand back anything it is asked for.
 * Authorization is therefore application code, and it lives here.
 *
 * The rule for this file: every function that touches member or staff data
 * calls a guard from src/lib/auth/guards.ts FIRST. Functions that are
 * genuinely public — the live filing, a product page — say so in a comment,
 * so "no guard" is always a decision rather than an oversight. And whatever
 * decides whether a filing or product can be seen goes through isVisible()
 * in src/lib/visibility.ts, the server's copy of the rule firestore.rules
 * applies to everyone else.
 */

export type FilingStatus = "draft" | "scheduled" | "live" | "closed";

/** Firestore's cap on the values in one `in` filter. */
const IN_LIMIT = 30;

/** Every document whose `field` is one of `values`, a query per 30 of them. */
async function whereIn(
  collection: string,
  field: string,
  values: string[],
): Promise<QueryDocumentSnapshot<DocumentData>[]> {
  const db = adminDb();
  const chunks: string[][] = [];
  for (let i = 0; i < values.length; i += IN_LIMIT) chunks.push(values.slice(i, i + IN_LIMIT));
  const snaps = await Promise.all(
    chunks.map((chunk) => db.collection(collection).where(field, "in", chunk).get()),
  );
  return snaps.flatMap((s) => s.docs);
}

const millis = (t: unknown): number => (t instanceof Timestamp ? t.toMillis() : 0);

type StoredImage = { id: string; path: string; alt?: string | null; position?: number };

/** A product document's images, in position order. */
function imagesOf(product: DocumentData): StoredImage[] {
  const list = Array.isArray(product.images) ? (product.images as StoredImage[]) : [];
  return [...list].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

export type FilingSlot = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  priceCents: number;
  /** Sum of stock across every variant. 0 means sold out. */
  stock: number;
  /**
   * Storage path of the primary image (position 0), served at /images/<path>.
   * Null until one is uploaded; the grid shows its text placeholder instead.
   */
  imageKey: string | null;
};

/**
 * PUBLIC BY DESIGN. The live filing and its products are the storefront —
 * to whoever may see them now. During a members' window that is signed-in
 * members only; before it, nobody but staff. Someone who may not see the live
 * filing gets null, the same as when nothing is live, and the grid shows its
 * placeholders.
 *
 * The live filing is found through state/currentFiling, the pointer the
 * filing-status function keeps, rather than by scanning filings.
 */
export async function getLiveFiling() {
  // Excludes the storefront from prerendering: stock and visibility have to be
  // read per request, never baked into a static page at build time.
  await connection();

  const db = adminDb();
  const viewer = viewerOf(await getSession());

  const pointer = (await db.doc("state/currentFiling").get()).data();
  if (typeof pointer?.filingId !== "string") return null;

  const filingSnap = await db.doc(`filings/${pointer.filingId}`).get();
  const f = filingSnap.data();
  if (!f || f.status !== "live" || !isVisible(f.status, f, viewer)) return null;

  const filing = {
    id: filingSnap.id,
    number: f.number as number,
    title: f.title as string,
    status: f.status as FilingStatus,
  };

  // Each product carries its own copies of the filing's status and times, and
  // they are what decides it — as in the rules.
  const productSnaps = (
    await db.collection("products").where("filingId", "==", filing.id).get()
  ).docs
    .filter((p) => isVisible(p.get("filingStatus"), p.data(), viewer))
    .sort((a, b) => (a.get("position") ?? 0) - (b.get("position") ?? 0) || millis(a.get("createdAt")) - millis(b.get("createdAt")));

  if (productSnaps.length === 0) return { filing, slots: [] as FilingSlot[] };

  // One extra read rather than N: every variant for these products, to total
  // the stock in memory.
  const stockByProduct = new Map<string, number>();
  for (const v of await whereIn("variants", "productId", productSnaps.map((p) => p.id))) {
    const productId = v.get("productId") as string;
    stockByProduct.set(productId, (stockByProduct.get(productId) ?? 0) + (v.get("stock") ?? 0));
  }

  const slots: FilingSlot[] = productSnaps.map((p) => {
    const data = p.data();
    return {
      id: p.id,
      slug: data.slug,
      name: data.name,
      kind: data.kind,
      priceCents: data.priceCents,
      stock: stockByProduct.get(p.id) ?? 0,
      imageKey: imagesOf(data)[0]?.path ?? null,
    };
  });

  return { filing, slots };
}

/**
 * Same as getLiveFiling, but never throws: a machine with no emulator running,
 * or a project with nothing in it yet, still renders the "awaiting asset"
 * placeholder slots, which is the correct pre-launch design anyway.
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
  /** Storage path, served at /images/<path>. */
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
 * Null unless the product's filing is live AND this viewer may see it now —
 * so during the members' window an anonymous visitor gets null, and the page
 * turns null into a real 404, exactly as for a slug that never existed. A
 * closed product is visible under the rules, but has no page here: the page
 * is a shop counter for what is on sale, as it always was.
 *
 * Variants come back unsummed. getLiveFiling totals them because the grid only
 * says "3 left"; a size picker has to know that M / Black is gone while
 * L / Black is not.
 *
 * Explicit projections, as everywhere a result reaches a page: the variants
 * are handed to a client component, so whatever is selected here is in the
 * browser. SKUs are staff business and stay behind.
 */
export async function getProductBySlug(
  slug: string,
): Promise<ProductPage | null> {
  // Request-time read — see getLiveFiling() for why this has to come first.
  await connection();

  const db = adminDb();
  const viewer = viewerOf(await getSession());

  const [productSnap] = (
    await db.collection("products").where("slug", "==", slug).limit(1).get()
  ).docs;
  const p = productSnap?.data();
  if (!p || p.filingStatus !== "live" || !isVisible(p.filingStatus, p, viewer)) return null;

  const [filingSnap, variantSnaps] = await Promise.all([
    db.doc(`filings/${p.filingId}`).get(),
    db.collection("variants").where("productId", "==", productSnap.id).get(),
  ]);
  const filingNumber = filingSnap.get("number");
  if (typeof filingNumber !== "number") return null;

  return {
    id: productSnap.id,
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    description: p.description ?? null,
    priceCents: p.priceCents,
    filingNumber,
    images: imagesOf(p).map((image) => ({ key: image.path, alt: image.alt ?? null })),
    variants: variantSnaps.docs
      .sort((a, b) => millis(a.get("createdAt")) - millis(b.get("createdAt")))
      .map((v) => ({ id: v.id, size: v.get("size"), color: v.get("color"), stock: v.get("stock") })),
  };
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
 * Anything else — a variant whose filing was never published, one this viewer
 * may not see yet, or no such variant at all. Nothing to show but the id that
 * was asked about.
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
 * Public stops at what this viewer may see. A variant on a live filing, inside
 * the viewer's window, comes back in full. One on a closed filing was on sale
 * once, so it still comes back in full, marked unavailable — whoever had it in
 * their bag when the drop ended can see what it was. Anything else — draft and
 * scheduled filings, a live one before this viewer's window opens — comes back
 * as a bare { variantId, available: false }: no name, no price. An id that
 * matches nothing gets that same bare row rather than being left out, so the
 * answer cannot be used to find out which unreleased ids exist.
 *
 * This shows someone what is wrong with their bag. It is not what decides the
 * order: checkout re-reads everything inside its transaction.
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

  const db = adminDb();
  const viewer = viewerOf(await getSession());

  const variantSnaps = await db.getAll(...ids.map((id) => db.doc(`variants/${id}`)));
  const productIds = [...new Set(variantSnaps.filter((v) => v.exists).map((v) => v.get("productId") as string))];
  const productSnaps = productIds.length
    ? await db.getAll(...productIds.map((id) => db.doc(`products/${id}`)))
    : [];
  const products = new Map(productSnaps.filter((p) => p.exists).map((p) => [p.id, p.data()!]));

  return ids.map((variantId, i): CartLine => {
    const v = variantSnaps[i].data();
    const p = v ? products.get(v.productId) : undefined;
    const status = p?.filingStatus;
    if (!v || !p || (status !== "live" && status !== "closed") || !isVisible(status, p, viewer)) {
      return { variantId, available: false };
    }
    return {
      variantId,
      available: status === "live",
      productName: p.name,
      size: v.size,
      color: v.color,
      priceCents: p.priceCents,
      stock: v.stock,
    };
  });
}

/* -------------------------------------------------------------------------
   Member record
   ------------------------------------------------------------------------- */

/** Orders shown on the record. A member page is not a paginated ledger. */
const ORDER_LIMIT = 50;

export type MemberOrderLine = {
  name: string;
  /** "M / Black". */
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

/** Null until the member's first paid order is issued a certificate. */
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

type StoredLine = {
  nameSnapshot: string;
  variantSnapshot?: string | null;
  quantity: number;
  unitPriceCents: number;
};

/**
 * Everything /account renders for the signed-in member.
 *
 * GUARDED. requireMember() runs first and the member id comes from the
 * verified session — never from a parameter, because there is no parameter.
 * The Admin SDK would hand back anyone's orders for any id it was given.
 *
 * Note the projections are explicit rather than the documents as stored.
 * Whatever a server component returns is serialised into the RSC payload and
 * shipped to the browser, and an order document carries a shipping address
 * and, once Stripe exists, a payment id. Neither is rendered; neither should
 * leave the server.
 *
 * One round trip: the certificate, the orders and the vote count are
 * independent, so they are read side by side. An order's lines live inside the
 * order document, so they come with it.
 */
export async function getMemberRecord(): Promise<MemberRecord> {
  // Guard before any read, per the rule at the top of this file. This also
  // calls connection() transitively, so the route stays out of the prerender.
  const me = await requireMember();

  const db = adminDb();

  const [certSnap, orderSnaps, votes] = await Promise.all([
    // Keyed by the member's id — at most one per member, forever.
    db.doc(`certificates/${me.id}`).get(),
    // Needs the (memberId, createdAt desc) index in firestore.indexes.json.
    db
      .collection("orders")
      .where("memberId", "==", me.id)
      .orderBy("createdAt", "desc")
      .limit(ORDER_LIMIT)
      .get(),
    db.collection("votes").where("memberId", "==", me.id).count().get(),
  ]);

  const cert = certSnap.data();

  return {
    user: me,
    certificate: cert
      ? { number: cert.number, class: cert.class, issuedAt: (cert.issuedAt as Timestamp).toDate() }
      : null,
    orders: orderSnaps.docs.map((o) => {
      const data = o.data();
      // `currency` is deliberately left behind. money() hardcodes $ and en-US,
      // so carrying a currency we then ignore is how a euro amount ends up
      // printed with a dollar sign.
      const lines = ((data.items ?? []) as StoredLine[])
        .map((line) => ({
          name: line.nameSnapshot,
          variant: line.variantSnapshot ?? null,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
        }))
        // The variant breaks ties between two sizes of the same product.
        .sort((a, b) => a.name.localeCompare(b.name) || (a.variant ?? "").localeCompare(b.variant ?? ""));
      return {
        id: o.id,
        status: data.status,
        totalCents: data.totalCents,
        placedAt: (data.createdAt as Timestamp).toDate(),
        lines,
      };
    }),
    votesCast: votes.data().count,
  };
}

/* -------------------------------------------------------------------------
   Back of house: the catalogue
   ------------------------------------------------------------------------- */

export type AdminVariant = {
  id: string;
  size: string;
  color: string;
  sku: string;
  stock: number;
};

export type AdminImage = {
  id: string;
  /** Storage path. The URL is /images/<path>, built where it is rendered. */
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
 * their images. The same shapes come back from the catalogue functions, so the
 * console can splice a created row straight into what it already holds.
 *
 * GUARDED. requireStaff() runs before any read.
 *
 * connection() comes first, and explicitly, even though getSession() calls it
 * too: this is a request-time read, and keeping it out of the prerender must
 * not hinge on what a guard happens to do internally.
 *
 * Three reads, each depending on the one before: the filings, their products,
 * those products' variants. Images live on the product documents. Ordering
 * happens in memory, so no query here needs a composite index.
 */
export async function getAdminCatalog(): Promise<AdminFiling[]> {
  await connection();
  await requireStaff();

  const db = adminDb();

  const filingSnaps = (
    await db.collection("filings").orderBy("number", "desc").limit(FILING_LIMIT).get()
  ).docs;
  const productSnaps = (await whereIn("products", "filingId", filingSnaps.map((f) => f.id))).sort(
    (a, b) => (a.get("position") ?? 0) - (b.get("position") ?? 0) || millis(a.get("createdAt")) - millis(b.get("createdAt")),
  );
  const variantSnaps = (await whereIn("variants", "productId", productSnaps.map((p) => p.id))).sort(
    (a, b) => millis(a.get("createdAt")) - millis(b.get("createdAt")),
  );

  const variantsByProduct = new Map<string, AdminVariant[]>();
  for (const v of variantSnaps) {
    const variant = { id: v.id, size: v.get("size"), color: v.get("color"), sku: v.get("sku"), stock: v.get("stock") };
    const list = variantsByProduct.get(v.get("productId"));
    if (list) list.push(variant);
    else variantsByProduct.set(v.get("productId"), [variant]);
  }

  const productsByFiling = new Map<string, AdminProduct[]>();
  for (const p of productSnaps) {
    const data = p.data();
    const row: AdminProduct = {
      id: p.id,
      slug: data.slug,
      name: data.name,
      kind: data.kind,
      priceCents: data.priceCents,
      variants: variantsByProduct.get(p.id) ?? [],
      images: imagesOf(data).map((image) => ({ id: image.id, r2Key: image.path })),
    };
    const list = productsByFiling.get(data.filingId);
    if (list) list.push(row);
    else productsByFiling.set(data.filingId, [row]);
  }

  return filingSnaps.map((f) => ({
    id: f.id,
    number: f.get("number"),
    title: f.get("title"),
    status: f.get("status"),
    products: productsByFiling.get(f.id) ?? [],
  }));
}
