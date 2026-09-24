import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Product images live in R2 and are served by src/app/images/[...key]/route.ts.
 *
 * No Cloudflare Images and no next/image: the catalogue is small, Images bills
 * per transform, and the OpenNext image optimiser does nothing useful without
 * that binding. Uploads are stored as sent and rendered with a plain <img>.
 */

/**
 * The R2 bucket, resolved per request the same way getDb() resolves D1 — the
 * binding does not exist outside one, so this cannot be a module singleton.
 */
export function getImageBucket(): R2Bucket {
  const { env } = getCloudflareContext();

  if (!env?.PRODUCT_IMAGES) {
    throw new Error(
      "R2 binding `PRODUCT_IMAGES` is missing. Check r2_buckets in " +
        "wrangler.jsonc, and restart `next dev` after changing it — the " +
        "miniflare proxy reads the config once, at startup.",
    );
  }

  return env.PRODUCT_IMAGES;
}

/**
 * Largest image accepted, in bytes.
 *
 * Paired with serverActions.bodySizeLimit in next.config.ts, which caps the
 * whole multipart request and so has to sit a little above this one — the
 * form's boundaries, part headers and other fields ride in the same body.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The formats accepted, and the extension each is stored under. */
const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
} as const;

export type ImageType = keyof typeof EXTENSIONS;

export function extensionFor(type: ImageType): string {
  return EXTENSIONS[type];
}

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

/**
 * The image format, decided from the file's own first bytes.
 *
 * Not from File.type: the browser fills that in from the filename's extension,
 * so it is exactly as client-supplied as the name itself. Whatever this returns
 * becomes the stored Content-Type, and the route serves it with nosniff — so a
 * file that is not really an image never gets a chance to be read as anything
 * else on this origin.
 *
 * SVG is deliberately absent. It is a document that can carry script, and
 * served from our own origin it would run with our cookies.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length < 12) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp";
  }
  // ISO base media: a box of type `ftyp` whose major brand is AVIF.
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";

  return null;
}
