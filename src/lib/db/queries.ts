import "server-only";

import { connection } from "next/server";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "./index";
import { filings, products, variants } from "./schema";

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
