import { connection } from "next/server";
import { getImageBucket } from "@/lib/images";

/**
 * PUBLIC BY DESIGN. Product images, streamed straight out of R2.
 *
 * A catch-all ([...key]) rather than [key], because every key has a slash in
 * it — `${productId}/${uuid}.${ext}`, see uploadProductImage(). A single
 * dynamic segment only matches one path segment, so /images/<product>/<file>
 * would 404 in the router before this handler ever ran. The segments are
 * joined back into the key.
 *
 * `immutable` is safe because a key is never written twice: every upload mints
 * a fresh UUID, and nothing overwrites an existing object. The bytes behind a
 * URL cannot change, so a browser never needs to ask again.
 *
 * The Content-Type is the one uploadProductImage() detected from the file's
 * bytes and stored on the object. nosniff holds browsers to it.
 *
 * Note this serves any key in the bucket, including images on products whose
 * filing is still a draft. The keys carry a random UUID, so an unpublished
 * image is unguessable rather than private — if drafts ever need to be truly
 * private, this is where a status check would go.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  // Request-time read, same rule as getLiveFiling(). A dynamic segment with no
  // generateStaticParams is not prerendered anyway, but this keeps the answer
  // from hinging on that.
  await connection();

  const { key } = await params;
  const object = await getImageBucket().get(key.join("/"));

  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  // Read the stored type as a plain value rather than calling
  // object.writeHttpMetadata(headers). Under `next dev` this binding is a
  // miniflare proxy, and that method has to ship a Headers instance across the
  // proxy boundary — which it cannot serialise, so every image 500s locally
  // while working fine on Workers. contentType is the only field
  // uploadProductImage() ever sets, so nothing is lost.
  return new Response(object.body, {
    headers: {
      "content-type":
        object.httpMetadata?.contentType ?? "application/octet-stream",
      etag: object.httpEtag,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
