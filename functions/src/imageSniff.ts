// Ported verbatim from the D1 app's image module — pure byte-sniffing logic with no
// Cloudflare/R2 dependency, so it copies unchanged into Node.

/** Largest image accepted, in bytes. */
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
 * Not from a client-supplied content type — exactly as untrustworthy as a
 * filename. Whatever this returns becomes the stored Content-Type.
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
