"use server";

import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { requireOwner, requireStaff } from "@/lib/auth/guards";
import {
  extensionFor,
  getImageBucket,
  MAX_IMAGE_BYTES,
  sniffImageType,
} from "@/lib/images";
import { getDb } from "./index";
import type {
  AdminFiling,
  AdminImage,
  AdminProduct,
  AdminVariant,
  FilingStatus,
} from "./queries";
import { filings, productImages, products, variants } from "./schema";

/**
 * Server Actions that write the catalogue. Staff-facing; customer writes live
 * in checkout.ts and stay there.
 *
 * Every export here is reachable by a direct POST from anyone who can load a
 * page, not only through the console — rendering the form only for staff is
 * not a security boundary. So each action calls its guard as its first line,
 * from the session, and treats every argument as untrusted input.
 *
 * Writes follow checkout.ts: unconditional, inside db.batch(), with the
 * database's own constraints deciding what is allowed — UNIQUE on the filing
 * number, the slug, the SKU and (product, size, color); FOREIGN KEY on every
 * parent id; CHECK on price and stock. Nothing reads first to ask whether a
 * slug is free. The insert either lands or a constraint throws, and explain()
 * turns the throw into a sentence. The one exception is updateFilingStatus(),
 * which says why.
 *
 * Expected failures — a taken slug, a malformed price — come back as
 * { ok: false, error } rather than being thrown, as Next's error-handling guide
 * prescribes: a thrown error reaches the browser as a generic failure with the
 * message stripped. Anything unexpected still throws.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/* -------------------------------------------------------------------------
   Filings
   ------------------------------------------------------------------------- */

export async function createFiling(input: {
  number: number;
  title: string;
}): Promise<ActionResult<AdminFiling>> {
  await requireStaff();

  return attempt(async () => {
    const number = wholeNumber(input?.number, "Filing number", 1, 999);
    const title = words(input?.title, "Title", 120);

    const db = getDb();
    const [[row]] = await db
      .batch([
        db
          .insert(filings)
          .values({ id: crypto.randomUUID(), number, title, status: "draft" })
          .returning({
            id: filings.id,
            number: filings.number,
            title: filings.title,
            status: filings.status,
          }),
      ])
      .catch(
        explain({
          "filings.number": `Filing ${pad(number)} already exists.`,
        }),
      );

    return { ...row, products: [] };
  });
}

const STATUSES = ["draft", "scheduled", "live", "closed"] as const;

/** Each status, and the one status a filing may reach it from. */
const PREVIOUS = {
  draft: null,
  scheduled: "draft",
  live: "scheduled",
  closed: "live",
} as const satisfies Record<FilingStatus, FilingStatus | null>;

/**
 * Move a filing one step along draft -> scheduled -> live -> closed.
 *
 * OWNER ONLY. Taking a filing live is what puts it in front of customers — the
 * one action in this file with consequences outside the console.
 *
 * This is the one write here that does not follow checkout.ts, on purpose. The
 * progression is a rule about a transition — the old status as well as the new
 * — and a CHECK constraint only ever sees the row being written, so no
 * constraint can express it. The update is conditional instead: it matches only
 * while the filing still holds the status that precedes the target.
 *
 * checkout.ts rules out conditional writes for a reason that does not reach
 * this one. There, a zero-row UPDATE inside a batch lets the batch's other
 * statements — the order, the line item — commit around it. Here the UPDATE is
 * the entire batch, and RETURNING says whether it landed: no row back means the
 * filing was not where the console thought (another tab, another owner) and
 * nothing at all was written. One statement, compare-and-set, atomic by itself.
 *
 * If this ought to be enforced by the database like everything else, the tool
 * is a BEFORE UPDATE trigger that RAISEs on a bad transition. There are no
 * triggers in this schema yet, so that would be a new mechanism, not this one.
 *
 * "Only one filing live at a time" IS enforced by the database, by
 * filings_one_live_idx in schema.ts. Taking a scheduled filing live while
 * another is live passes the WHERE above, then fails that index — and the
 * failure is reported naming the filing still holding 'live'. Nothing is ever
 * closed automatically: pulling a drop out from under someone without being
 * asked is a worse surprise than asking them to do it.
 */
export async function updateFilingStatus(input: {
  filingId: string;
  status: FilingStatus;
}): Promise<ActionResult<{ id: string; status: FilingStatus }>> {
  await requireOwner();

  return attempt(async () => {
    const filingId = reference(input?.filingId, "Filing");
    const status = oneOf(input?.status, STATUSES, "Status");
    const from = PREVIOUS[status];
    if (!from) throw new Rejected("A filing cannot go back to draft.");

    const db = getDb();
    const [rows] = await db
      .batch([
        db
          .update(filings)
          .set({ status })
          .where(and(eq(filings.id, filingId), eq(filings.status, from)))
          .returning({ id: filings.id, status: filings.status }),
      ])
      .catch(async (err: unknown): Promise<never> => {
        if (!isLiveClash(err)) throw err;

        // The index has already refused the write. This read decides nothing;
        // it only finds which filing to name. explain() cannot do it — that
        // maps a message to a fixed sentence, and this sentence needs a query.
        const [live] = await db
          .select({ number: filings.number })
          .from(filings)
          .where(eq(filings.status, "live"))
          .limit(1);

        // Empty only if the live filing was closed in the moment between the
        // failed write and this read. Nothing to name then, and trying again
        // would now succeed.
        throw new Rejected(
          live
            ? `Filing ${pad(live.number)} is still live — close it before taking this one live.`
            : "Another filing was live a moment ago and may have just closed. Try again.",
        );
      });

    if (rows.length === 0) {
      throw new Rejected(
        `Only a ${from} filing can move to ${status}, and this one is not ` +
          `${from} any more. Reload to see where it is.`,
      );
    }
    return rows[0];
  });
}

/* -------------------------------------------------------------------------
   Products and variants
   ------------------------------------------------------------------------- */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function createProduct(input: {
  filingId: string;
  slug: string;
  name: string;
  kind: string;
  description?: string;
  priceCents: number;
}): Promise<ActionResult<AdminProduct>> {
  await requireStaff();

  return attempt(async () => {
    const filingId = reference(input?.filingId, "Filing");
    const name = words(input?.name, "Name", 120);
    const kind = words(input?.kind, "Kind", 40);
    const description = optionalWords(input?.description, "Description", 2000);
    const slug = words(input?.slug, "Slug", 80);
    if (!SLUG.test(slug)) {
      throw new Rejected(
        "Slug is lowercase letters, digits and single dashes, like void-stamp-hood.",
      );
    }
    const priceCents = input?.priceCents;
    if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
      throw new Rejected("Price must be zero or more, in whole cents.");
    }

    const db = getDb();
    const [[row]] = await db
      .batch([
        db
          .insert(products)
          .values({
            id: crypto.randomUUID(),
            filingId,
            slug,
            name,
            kind,
            description,
            priceCents,
            // Next slot on the grid, counted inside the insert rather than read
            // beforehand. Two products added at the same instant can share a
            // position; nothing breaks, the pair just sorts in whatever order
            // SQLite returns a tie.
            position: sql`(SELECT COUNT(*) FROM ${products} WHERE ${products.filingId} = ${filingId})`,
          })
          .returning({
            id: products.id,
            slug: products.slug,
            name: products.name,
            kind: products.kind,
            priceCents: products.priceCents,
          }),
      ])
      .catch(
        explain({
          "products.slug": `The slug "${slug}" is already taken.`,
          "FOREIGN KEY constraint failed": "That filing no longer exists.",
        }),
      );

    return { ...row, variants: [], images: [] };
  });
}

export async function createVariant(input: {
  productId: string;
  size: string;
  color: string;
  sku: string;
  stock: number;
}): Promise<ActionResult<AdminVariant>> {
  await requireStaff();

  return attempt(async () => {
    const productId = reference(input?.productId, "Product");
    const size = words(input?.size, "Size", 16);
    const color = words(input?.color, "Color", 40);
    const sku = words(input?.sku, "SKU", 64);
    const stock = wholeNumber(input?.stock, "Stock", 0, 100_000);

    const db = getDb();
    const [[row]] = await db
      .batch([
        db
          .insert(variants)
          .values({ id: crypto.randomUUID(), productId, size, color, sku, stock })
          .returning({
            id: variants.id,
            size: variants.size,
            color: variants.color,
            sku: variants.sku,
            stock: variants.stock,
          }),
      ])
      .catch(
        explain({
          "variants.sku": `SKU ${sku} is already in use.`,
          "variants.product_id":
            `This product already has a ${size} / ${color} variant.`,
          "FOREIGN KEY constraint failed": "That product no longer exists.",
        }),
      );

    return row;
  });
}

/* -------------------------------------------------------------------------
   Images
   ------------------------------------------------------------------------- */

/**
 * Store one product image in R2 and record it against the product.
 *
 * Takes FormData — `productId` and `file` — because that is how a file reaches
 * a Server Action. The request is capped by serverActions.bodySizeLimit in
 * next.config.ts; MAX_IMAGE_BYTES is the real limit and is checked here.
 *
 * The client supplies nothing that becomes part of the stored object except
 * the bytes. Not the filename, and not File.type either — the browser derives
 * that from the filename, so it is no more trustworthy. The format is sniffed
 * from the bytes, and the key is minted here.
 */
export async function uploadProductImage(
  form: FormData,
): Promise<ActionResult<AdminImage>> {
  await requireStaff();

  return attempt(async () => {
    if (!(form instanceof FormData)) {
      throw new Rejected("Expected a form upload.");
    }
    const productId = reference(form.get("productId"), "Product");
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new Rejected("Choose an image to upload.");
    }
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Rejected(
        `Images are capped at ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffImageType(bytes);
    if (!type) {
      throw new Rejected("That file is not a JPEG, PNG, WebP, AVIF or GIF.");
    }

    // The product id is safe to use as a key prefix because reference() only
    // lets through [A-Za-z0-9_-]. Whether the product exists is the FOREIGN
    // KEY's call, below.
    const key = `${productId}/${crypto.randomUUID()}.${extensionFor(type)}`;

    // Object first, row second — the reverse order would leave a row pointing
    // at an object that never arrived, which is a broken image on the grid.
    const bucket = getImageBucket();
    await bucket.put(key, bytes, { httpMetadata: { contentType: type } });

    const db = getDb();
    try {
      const [[row]] = await db.batch([
        db
          .insert(productImages)
          .values({
            id: crypto.randomUUID(),
            productId,
            r2Key: key,
            // Appended after the product's existing images; same reasoning as
            // position in createProduct().
            position: sql`(SELECT COUNT(*) FROM ${productImages} WHERE ${productImages.productId} = ${productId})`,
          })
          .returning({ id: productImages.id, r2Key: productImages.r2Key }),
      ]);
      return row;
    } catch (err) {
      // ORPHANED OBJECT. R2 and D1 share no transaction, so if the row fails
      // after the put succeeded, the object is in the bucket with nothing
      // pointing at it.
      //
      // The delete below is best effort and will usually clean that up. It is
      // not a guarantee: it can fail in its own right, and a worker that dies
      // between the put and this line never reaches it. An orphan costs
      // storage, not correctness — no row means no URL anywhere in the app.
      // Clearing any that slip through takes a sweep that lists the bucket and
      // drops keys with no product_images row; that sweep does not exist yet.
      await bucket.delete(key).catch(() => {});
      return explain({
        "FOREIGN KEY constraint failed": "That product no longer exists.",
      })(err);
    }
  });
}

/* -------------------------------------------------------------------------
   Plumbing. Not exported — a "use server" file may export only actions.
   ------------------------------------------------------------------------- */

/** A failure worth showing staff verbatim. Anything else is a bug and throws. */
class Rejected extends Error {}

async function attempt<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    if (err instanceof Rejected) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Translate a constraint the database enforced into a sentence for staff.
 * `reasons` maps a fragment of SQLite's message to what to say instead;
 * an error matching none of them was not expected, and rethrows untouched.
 */
function explain(reasons: Record<string, string>) {
  return (err: unknown): never => {
    const message = driverMessage(err);
    for (const [fragment, reason] of Object.entries(reasons)) {
      if (message.includes(fragment)) throw new Rejected(reason);
    }
    throw err;
  };
}

/**
 * SQLite's own message, wherever Drizzle left it.
 *
 * A statement run on its own is wrapped in a DrizzleQueryError whose message is
 * the SQL and its parameters — including whatever staff typed — with the
 * driver's error on `cause`. db.batch() is not wrapped. Taking the innermost
 * cause reads the right text either way, and never matches a fragment against
 * user input.
 */
function driverMessage(err: unknown): string {
  let e = err;
  while (e instanceof Error && e.cause instanceof Error) e = e.cause;
  return e instanceof Error ? e.message : String(e);
}

/**
 * The one failure filings_one_live_idx produces. Both fragments are checked:
 * a duplicate filing number is also "UNIQUE constraint failed", but on
 * filings.number, and must not be reported as a live clash.
 */
function isLiveClash(err: unknown): boolean {
  const message = driverMessage(err);
  return (
    message.includes("UNIQUE constraint failed") &&
    message.includes("filings.status")
  );
}

function words(value: unknown, label: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Rejected(`${label} is required.`);
  if (text.length > max) {
    throw new Rejected(`${label} is capped at ${max} characters.`);
  }
  return text;
}

function optionalWords(
  value: unknown,
  label: string,
  max: number,
): string | null {
  if (value == null || (typeof value === "string" && !value.trim())) {
    return null;
  }
  return words(value, label, max);
}

function wholeNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Rejected(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/**
 * An id the client is pointing at. Every id in this schema is a UUID or a seed
 * id like prd_01, so anything outside [A-Za-z0-9_-] is refused outright —
 * which is also what makes a product id safe inside an R2 key. Whether the row
 * exists is left to the FOREIGN KEY.
 */
function reference(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Rejected(`${label} is missing or malformed.`);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new Rejected(`${label} must be one of ${options.join(", ")}.`);
  }
  return value as T;
}

const pad = (n: number) => String(n).padStart(3, "0");
