import { onCall } from "firebase-functions/v2/https";
import { db, FieldValue } from "./firebase";
import { requireStaff, attempt, Rejected } from "./guards";
import { words, optionalWords, reference, SLUG } from "./validation";

/**
 * Mirrors src/lib/db/admin.ts's createProduct() (lines 186-248).
 *
 * Doc id = the slug, not a random id. Gets uniqueness for free from
 * create()'s exists-check inside the transaction (Firestore aborts/retries
 * on a concurrent create to the same id, same as D1's UNIQUE on
 * products.slug failing a statement) and matches the existing
 * {filingId}_{memberId} pattern already used for votes. Confirmed nothing
 * else in the codebase references products by a non-slug id — orders/
 * order_items only ever store variantId plus denormalized snapshots.
 */
export const createProduct = onCall(async (request) => {
  requireStaff(request);

  return attempt(async () => {
    const data = request.data ?? {};
    const filingId = reference(data.filingId, "Filing");
    const name = words(data.name, "Name", 120);
    const kind = words(data.kind, "Kind", 40);
    const description = optionalWords(data.description, "Description", 2000);
    const slug = words(data.slug, "Slug", 80);
    if (!SLUG.test(slug)) {
      throw new Rejected("Slug is lowercase letters, digits and single dashes, like void-stamp-hood.");
    }
    const priceCents = data.priceCents;
    if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
      throw new Rejected("Price must be zero or more, in whole cents.");
    }

    const filingRef = db.collection("filings").doc(filingId);
    const productRef = db.collection("products").doc(slug);

    // Next slot on the grid. Read outside the transaction and tolerated as
    // loose under concurrent creates, same as D1's correlated-subquery
    // position: two products added at the same instant can share a position;
    // nothing breaks, the pair just sorts in whatever order Firestore
    // returns a tie.
    const countSnap = await db.collection("products").where("filingId", "==", filingId).count().get();
    const position = countSnap.data().count;

    const record = await db.runTransaction(async (t) => {
      const [filingSnap, productSnap] = await Promise.all([t.get(filingRef), t.get(productRef)]);
      if (!filingSnap.exists) throw new Rejected("That filing no longer exists.");
      if (productSnap.exists) throw new Rejected(`The slug "${slug}" is already taken.`);
      const filing = filingSnap.data()!;

      const doc = {
        filingId,
        slug,
        name,
        kind,
        description,
        priceCents,
        position,
        // Denormalized snapshot of the PARENT FILING'S CURRENT state, copied
        // at creation time — matches D1: a product added to an already-live
        // filing is immediately part of the live catalog, no separate review
        // gate.
        filingStatus: filing.status,
        ...(filing.publicAt ? { publicAt: filing.publicAt } : {}),
        ...(filing.memberAccessAt ? { memberAccessAt: filing.memberAccessAt } : {}),
        images: [] as unknown[],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      t.create(productRef, doc);
      return doc;
    });

    return { id: slug, slug, name: record.name, kind: record.kind, priceCents: record.priceCents, variants: [], images: [] };
  });
});
