import * as crypto from "node:crypto";
import { onCall } from "firebase-functions/v2/https";
import { db, storage, FieldValue } from "./firebase";
import { requireStaff, attempt, Rejected } from "./guards";
import { reference } from "./validation";
import { MAX_IMAGE_BYTES, sniffImageType, extensionFor } from "./imageSniff";

/**
 * The console's uploadProductImage(), storing to Cloud Storage for Firebase.
 *
 * A callable's only input mode is JSON, so the file travels as base64 rather
 * than FormData: {productId, fileBase64}. 2nd-gen callables accept up to
 * 32MB per request (10MB on 1st-gen) — an 8MB image becomes ~11MB
 * base64-encoded, comfortably inside that.
 *
 * Object first, doc second: the reverse order would leave a doc pointing at
 * bytes that never arrived.
 * On a doc-write failure after a successful object write, best-effort
 * deletes the object. Not guaranteed (can itself fail, or the function can
 * die before reaching it) — an accepted, documented, non-correctness-
 * affecting gap: an orphaned object costs storage, not correctness, and a
 * sweep to reconcile the bucket against product documents does not exist
 * yet.
 */
export const uploadProductImage = onCall(async (request) => {
  await requireStaff(request);

  return attempt(async () => {
    const data = request.data ?? {};
    const productId = reference(data.productId, "Product");
    if (typeof data.fileBase64 !== "string" || !data.fileBase64) {
      throw new Rejected("Choose an image to upload.");
    }

    const bytes = Buffer.from(data.fileBase64, "base64");
    if (bytes.length === 0) throw new Rejected("Choose an image to upload.");
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Rejected(`Images are capped at ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    }
    const type = sniffImageType(bytes);
    if (!type) throw new Rejected("That file is not a JPEG, PNG, WebP, AVIF or GIF.");

    const productRef = db.collection("products").doc(productId);
    const productSnap = await productRef.get();
    if (!productSnap.exists) throw new Rejected("That product no longer exists.");

    // reference() lets only [A-Za-z0-9_-] through, so the product id is safe
    // as a path segment, and the image route can read it back out of the key.
    const id = crypto.randomUUID();
    const path = `products/${productId}/${id}.${extensionFor(type)}`;

    const file = storage.bucket().file(path);
    await file.save(bytes, { contentType: type, resumable: false });

    try {
      const existing = (productSnap.data()?.images as unknown[] | undefined) ?? [];
      const image = { id, path, alt: null, position: existing.length };
      await productRef.update({ images: FieldValue.arrayUnion(image) });
      return image;
    } catch (err) {
      await file.delete().catch(() => {});
      throw err;
    }
  });
});
