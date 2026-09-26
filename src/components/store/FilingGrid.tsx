import Link from "next/link";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow, Section, Wrap, cx } from "@/components/ui/Layout";
import { getLiveFilingSafe, type FilingSlot } from "@/lib/db/queries";
import { money } from "@/lib/format";
import styles from "./FilingGrid.module.css";

/**
 * The grid draws its dividing rules with 1px gaps over an ash background, so a
 * short final row leaves a bare grey block rather than empty space. Always
 * render a whole number of rows, padding with reserved slots — which is the
 * mockup's own convention ("Slot 04 / Reserved").
 */
const COLUMNS = 4;

const KINDS = ["Tee", "Tee", "Hood", "Reserved"];

type Cell =
  | { kind: "product"; product: FilingSlot }
  | { kind: "placeholder"; slot: string; label: string };

/** Pad a product list up to a full row of reserved slots. */
function toCells(products: FilingSlot[]): Cell[] {
  const cells: Cell[] = products.map((product) => ({
    kind: "product",
    product,
  }));

  const target = Math.max(COLUMNS, Math.ceil(cells.length / COLUMNS) * COLUMNS);

  for (let i = cells.length; i < target; i++) {
    cells.push({
      kind: "placeholder",
      slot: String(i + 1).padStart(2, "0"),
      label: KINDS[i] ?? "Reserved",
    });
  }

  return cells;
}

/** Server Component. Reads D1 directly — the browser never queries the database. */
export async function FilingGrid() {
  const live = await getLiveFilingSafe();
  const products = live?.slots ?? [];
  const cells = toCells(products);
  const number = live ? String(live.filing.number).padStart(3, "0") : "001";

  return (
    <Section id="filing">
      <Wrap>
        <Eyebrow
          left={
            <>
              Filing {number} <b>/ {live ? live.filing.status : "unscheduled"}</b>
            </>
          }
          right="Form DI-11"
        />

        <div className={styles.grid}>
          {cells.map((cell) =>
            cell.kind === "product" ? (
              <Link
                key={cell.product.id}
                href={`/product/${cell.product.slug}`}
                className={styles.slot}
              >
                {/* Hidden from assistive tech: everything in the frame — the
                    photo's alt, or the name and stock text — is said again in
                    .meta below, and a link would otherwise be read out as
                    "Night Shift Tee Night Shift Tee Tee 7 left $48.50". The
                    alt stays for a photo that fails to load. */}
                <div className={cx(styles.frame, "rough")} aria-hidden="true">
                  {cell.product.imageKey ? (
                    // Plain <img>, not next/image: the optimiser needs a
                    // Cloudflare Images binding this app deliberately skips.
                    // See src/lib/images.ts.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className={styles.photo}
                      src={`/images/${cell.product.imageKey}`}
                      alt={cell.product.name}
                    />
                  ) : (
                    <span>
                      {cell.product.name}
                      <br />
                      {cell.product.stock > 0
                        ? `${cell.product.stock} left`
                        : "sold out"}
                    </span>
                  )}
                </div>
                {/* What it is, and whether it can be bought — for every
                    product, because once a photo fills the frame this is the
                    only place either is written. Two rows: name and kind,
                    then stock and price, so "sold out" sits beside the
                    price it strikes through. */}
                <div className={styles.meta}>
                  <div className={styles.row}>
                    <span className={styles.name}>{cell.product.name}</span>
                    <span className={cx(styles.label, styles.end)}>
                      {cell.product.kind}
                    </span>
                  </div>
                  <div className={styles.row}>
                    <span
                      className={cx(
                        styles.label,
                        cell.product.stock === 0 && styles.out,
                      )}
                    >
                      {cell.product.stock > 0
                        ? `${cell.product.stock} left`
                        : "sold out"}
                    </span>
                    <span
                      className={cx(
                        styles.price,
                        cell.product.stock === 0 && styles.out,
                      )}
                    >
                      {money(cell.product.priceCents)}
                    </span>
                  </div>
                </div>
              </Link>
            ) : (
              <Link key={cell.slot} href="/soon" className={styles.slot}>
                <div className={cx(styles.frame, "rough")}>
                  <span>
                    Slot {cell.slot}
                    <br />
                    awaiting asset
                  </span>
                </div>
                {/* One row: no product, so no name and no stock. The kind
                    takes the same label style as a product's, so the two
                    read alike side by side. */}
                <div className={cx(styles.meta, styles.row)}>
                  <span className={styles.label}>{cell.label}</span>
                  <span className={styles.price}>TBD</span>
                </div>
              </Link>
            ),
          )}
        </div>

        {products.length === 0 && (
          <div className={styles.overflow}>
            <EmptyState
              title="Nothing is live yet"
              action={<ButtonLink href="/account">Get on the list</ButtonLink>}
            >
              The first filing has not posted. When it does, members see it two
              days before anyone else and the run sells out or it does not.
            </EmptyState>
          </div>
        )}
      </Wrap>
    </Section>
  );
}
