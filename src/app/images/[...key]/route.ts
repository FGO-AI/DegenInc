import { Readable } from "node:stream";
import { connection } from "next/server";
import { getSession } from "@/lib/auth/guards";
import { adminBucket, adminDb } from "@/lib/firebase/admin";
import { isVisible, viewerOf, type Viewer } from "@/lib/visibility";

/**
 * Product images, streamed out of Cloud Storage — to whoever may see the
 * product they belong to, and nobody else.
 *
 * Every key the upload function writes is products/<productId>/<uuid>.<ext>.
 * A catch-all ([...key]) rather than [key], because a single dynamic segment
 * only matches one path segment; the segments are joined back into the key.
 *
 * The Admin SDK reads the bucket regardless of storage.rules, so this route is
 * the whole of the protection, and it checks three things before streaming:
 * the key has that shape; the product it names exists and lists this exact
 * key among its images; and the product is visible to this viewer now, by the
 * same isVisible() every other server read uses. An image of a product in its
 * members' window does not load for an anonymous visitor. Any failure is the
 * same plain 404, so the answer says nothing about which keys exist.
 *
 * Caching follows who may see it. An image anyone may see now — a live product
 * past its publicAt, or a closed one — is `public, immutable`: a key is never
 * written twice, so the bytes behind a URL cannot change, and a product never
 * becomes less visible than that. Anything else — a members'-window image
 * shown to a member, a draft shown to staff — is `private, no-store`, so no
 * CDN or shared cache ever holds a pre-release image.
 *
 * The Content-Type is the one the upload function sniffed from the bytes and
 * stored on the object; nosniff holds browsers to it.
 */

const KEY = /^products\/([A-Za-z0-9_-]{1,128})\/[0-9a-f-]{36}\.(jpg|png|webp|avif|gif)$/;
const ANYONE: Viewer = { signedIn: false, staff: false };

const notFound = () =>
  new Response("Not found", { status: 404, headers: { "cache-control": "private, no-store" } });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  // Request-time: who is asking decides the answer.
  await connection();

  const key = (await params).key.join("/");
  const match = KEY.exec(key);
  if (!match) return notFound();

  const product = (await adminDb().doc(`products/${match[1]}`).get()).data();
  const listed =
    Array.isArray(product?.images) &&
    product.images.some((image: { path?: unknown }) => image?.path === key);
  if (!product || !listed) return notFound();

  const viewer = viewerOf(await getSession());
  if (!isVisible(product.filingStatus, product, viewer)) return notFound();

  const file = adminBucket().file(key);
  let meta;
  try {
    [meta] = await file.getMetadata();
  } catch {
    return notFound();
  }

  const cacheable = isVisible(product.filingStatus, product, ANYONE);

  return new Response(Readable.toWeb(file.createReadStream()) as ReadableStream, {
    headers: {
      "content-type": meta.contentType ?? "application/octet-stream",
      ...(meta.size ? { "content-length": String(meta.size) } : {}),
      ...(meta.etag ? { etag: meta.etag } : {}),
      "cache-control": cacheable ? "public, max-age=31536000, immutable" : "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
