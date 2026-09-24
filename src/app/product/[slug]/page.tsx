import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Footer } from "@/components/chrome/Footer";
import { Masthead } from "@/components/chrome/Masthead";
import { BackLink } from "@/components/ui/Button";
import { Cols, Eyebrow, Section, Wrap, cx } from "@/components/ui/Layout";
import { getProductBySlug, type ProductImage } from "@/lib/db/queries";
import { money } from "@/lib/format";
import { VariantPicker } from "./VariantPicker";
import styles from "./page.module.css";

type Props = { params: Promise<{ slug: string }> };

/**
 * One read per request, shared by generateMetadata and the page — React's
 * cache memoises it for the duration of a single render.
 */
const loadProduct = cache(getProductBySlug);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const product = await loadProduct((await params).slug);
  // Nothing to say: the page calls notFound(), and a not-found render takes
  // its metadata from the boundary, not from here.
  if (!product) return {};
  return {
    title: product.name,
    description: product.description ?? undefined,
  };
}

/**
 * A product on the live filing.
 *
 * getProductBySlug() returns null for anything not on a live filing — never
 * released, still scheduled, closed, or no such slug — and this turns that
 * into a real 404. notFound() runs before anything renders, and nothing above
 * this page (no loading.tsx, no Suspense) streams a shell first, so the status
 * is still unsent and becomes 404 rather than a 200 carrying a not-found body.
 * Keep it that way: a loading.tsx in this segment would quietly make every
 * missing product a 200.
 */
export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const product = await loadProduct(slug);
  if (!product) notFound();

  const filing = String(product.filingNumber).padStart(3, "0");
  const [lead, ...more] = product.images;

  return (
    <>
      <Masthead />

      <Section tone="clear">
        <Wrap>
          <Eyebrow
            left={
              <>
                Filing {filing} <b>/ live</b>
              </>
            }
            right="Form DI-13"
          />

          <Cols>
            <div>
              <Shot image={lead} alt={product.name} lead />
              {more.length > 0 && (
                <div className={styles.more}>
                  {more.map((image, i) => (
                    <Shot
                      key={image.key}
                      image={image}
                      alt={`${product.name}, view ${i + 2}`}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className={styles.detail}>
              <p className="mono">{product.kind}</p>
              <h1 className={cx(styles.name, "eroded")}>{product.name}</h1>
              <p className={styles.price}>{money(product.priceCents)}</p>
              {product.description && (
                <p className={styles.description}>{product.description}</p>
              )}

              <VariantPicker
                productName={product.name}
                variants={product.variants}
              />

              <BackLink href="/#filing">Back to Filing {filing}</BackLink>
            </div>
          </Cols>
        </Wrap>
      </Section>

      <Footer
        note={`Filing ${filing} / ${product.kind}`}
        form="Form DI-13 / rev. 2026"
      />
    </>
  );
}

/**
 * One product shot in the grid's hatched frame, or the frame alone with the
 * grid's "awaiting asset" line when nothing has been uploaded yet.
 */
function Shot({
  image,
  alt,
  lead = false,
}: {
  image: ProductImage | undefined;
  alt: string;
  lead?: boolean;
}) {
  return (
    <div className={cx(styles.frame, "rough")}>
      {image ? (
        // Plain <img>, not next/image: the optimiser needs a Cloudflare Images
        // binding this app deliberately skips. See src/lib/images.ts.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className={styles.photo}
          src={`/images/${image.key}`}
          alt={image.alt ?? alt}
          // The lead shot is the largest thing on the page; the rest can wait.
          loading={lead ? "eager" : "lazy"}
        />
      ) : (
        <span>
          {alt}
          <br />
          awaiting asset
        </span>
      )}
    </div>
  );
}
