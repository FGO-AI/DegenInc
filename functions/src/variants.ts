import { onCall } from "firebase-functions/v2/https";
import { db, FieldValue } from "./firebase";
import { requireStaff, attempt, Rejected } from "./guards";
import { words, wholeNumber, reference, docIdFrom } from "./validation";
import { claimingUnique } from "./unique";

/**
 * Mirrors the D1 console's createVariant().
 *
 * Variants live in the top-level variants collection under a random id, with
 * the product they belong to in productId. The bag, /api/cart and checkout
 * know a variant by its id alone, so the id has to be unique on its own, not
 * only within one product.
 *
 * Two of D1's constraints carry over, each held by a lookup document created
 * in the same transaction (unique.ts): the SKU, unique across every product,
 * in skus/{sku}; and the product's size and colour, unique within it, in
 * variantKeys/{productId}_{size}_{color}.
 */
export const createVariant = onCall(async (request) => {
  await requireStaff(request);

  return attempt(async () => {
    const data = request.data ?? {};
    const productId = reference(data.productId, "Product");
    const size = words(data.size, "Size", 16);
    const color = words(data.color, "Color", 40);
    const sku = words(data.sku, "SKU", 64);
    const stock = wholeNumber(data.stock, "Stock", 0, 100_000);

    const productRef = db.collection("products").doc(productId);
    const variantRef = db.collection("variants").doc();
    const skuRef = db.collection("skus").doc(docIdFrom(sku));
    const keyRef = db.collection("variantKeys").doc(docIdFrom(productId, size, color));
    const skuTaken = `SKU ${sku} is already in use.`;
    const keyTaken = `This product already has a ${size} / ${color} variant.`;

    const variant = await claimingUnique({ variantKeys: keyTaken, skus: skuTaken }, () =>
      db.runTransaction(async (t) => {
        const [productSnap, keySnap, skuSnap] = await Promise.all([
          t.get(productRef),
          t.get(keyRef),
          t.get(skuRef),
        ]);
        if (!productSnap.exists) throw new Rejected("That product no longer exists.");
        if (keySnap.exists) throw new Rejected(keyTaken);
        if (skuSnap.exists) throw new Rejected(skuTaken);

        const doc = {
          productId,
          size,
          color,
          sku,
          stock,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        t.create(keyRef, { variantId: variantRef.id });
        t.create(skuRef, { productId, variantId: variantRef.id });
        t.create(variantRef, doc);
        return doc;
      }),
    );

    return { id: variantRef.id, size: variant.size, color: variant.color, sku: variant.sku, stock: variant.stock };
  });
});
