import { onCall } from "firebase-functions/v2/https";
import { db, FieldValue } from "./firebase";
import { requireStaff, attempt, Rejected } from "./guards";
import { words, wholeNumber, reference, docIdFrom } from "./validation";

/**
 * Mirrors src/lib/db/admin.ts's createVariant() (lines 250-291).
 *
 * (productId, size, color) uniqueness comes free from the composite doc id
 * within the product's own variants subcollection — same reasoning as
 * slug-as-id for products.
 *
 * variants.sku is UNIQUE *globally* in D1, not scoped to a product, so
 * there's no natural parent to hang a doc id off for that one. The skus/{sku}
 * collection (deny-all rules, same shape as counters) exists solely to give
 * that global constraint somewhere to live — written in the same transaction
 * as the variant it belongs to, so either both land or neither does.
 */
export const createVariant = onCall(async (request) => {
  requireStaff(request);

  return attempt(async () => {
    const data = request.data ?? {};
    const productId = reference(data.productId, "Product"); // the product's slug
    const size = words(data.size, "Size", 16);
    const color = words(data.color, "Color", 40);
    const sku = words(data.sku, "SKU", 64);
    const stock = wholeNumber(data.stock, "Stock", 0, 100_000);

    const variantId = docIdFrom(size, color);
    const skuId = docIdFrom(sku);

    const productRef = db.collection("products").doc(productId);
    const variantRef = productRef.collection("variants").doc(variantId);
    const skuRef = db.collection("skus").doc(skuId);

    const variant = await db.runTransaction(async (t) => {
      const [productSnap, variantSnap, skuSnap] = await Promise.all([
        t.get(productRef),
        t.get(variantRef),
        t.get(skuRef),
      ]);
      if (!productSnap.exists) throw new Rejected("That product no longer exists.");
      if (variantSnap.exists) throw new Rejected(`This product already has a ${size} / ${color} variant.`);
      if (skuSnap.exists) throw new Rejected(`SKU ${sku} is already in use.`);

      const doc = {
        size,
        color,
        sku,
        stock,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      t.create(variantRef, doc);
      t.create(skuRef, { productId, variantId, createdAt: FieldValue.serverTimestamp() });
      return doc;
    });

    return { id: variantId, size: variant.size, color: variant.color, sku: variant.sku, stock: variant.stock };
  });
});
