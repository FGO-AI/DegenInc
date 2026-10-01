import { onCall } from "firebase-functions/v2/https";
import { db, FieldValue } from "./firebase";
import { requireStaff, attempt, Rejected } from "./guards";
import { words, optionalWords, reference, SLUG } from "./validation";
import { claimingUnique } from "./unique";

/**
 * The console's createProduct().
 *
 * The product gets a random id; its slug, which must be unique, is held by a
 * slugs/{slug} lookup created in the same transaction (unique.ts). The slug is
 * safe as a document id as it stands: SLUG allows only lowercase letters,
 * digits and single dashes.
 */
export const createProduct = onCall(async (request) => {
  await requireStaff(request);

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
    const productRef = db.collection("products").doc();
    const slugRef = db.collection("slugs").doc(slug);
    const taken = `The slug "${slug}" is already taken.`;

    // Next slot on the grid. Read outside the transaction and tolerated as
    // loose under concurrent creates, as it always was: two products added at the same instant can share a position;
    // nothing breaks, the pair just sorts in whatever order Firestore
    // returns a tie.
    const countSnap = await db.collection("products").where("filingId", "==", filingId).count().get();
    const position = countSnap.data().count;

    const record = await claimingUnique({ slugs: taken }, () =>
      db.runTransaction(async (t) => {
        const [filingSnap, slugSnap] = await Promise.all([t.get(filingRef), t.get(slugRef)]);
        if (!filingSnap.exists) throw new Rejected("That filing no longer exists.");
        if (slugSnap.exists) throw new Rejected(taken);
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
          // at creation time, as it always worked: a product added to an already-live
          // filing is immediately part of the live catalog, no separate review
          // gate.
          filingStatus: filing.status,
          ...(filing.publicAt ? { publicAt: filing.publicAt } : {}),
          ...(filing.memberAccessAt ? { memberAccessAt: filing.memberAccessAt } : {}),
          images: [] as unknown[],
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        t.create(slugRef, { productId: productRef.id });
        t.create(productRef, doc);
        return doc;
      }),
    );

    return { id: productRef.id, slug, name: record.name, kind: record.kind, priceCents: record.priceCents, variants: [], images: [] };
  });
});
