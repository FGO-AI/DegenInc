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
                href="/soon"
                className={styles.slot}
              >
                <div className={cx(styles.frame, "rough")}>
                  <span>
                    {cell.product.name}
                    <br />
                    {cell.product.stock > 0
                      ? `${cell.product.stock} left`
                      : "sold out"}
                  </span>
                </div>
                <div className={styles.meta}>
                  <span>{cell.product.kind}</span>
                  <span className={styles.price}>
                    {money(cell.product.priceCents)}
                  </span>
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
                <div className={styles.meta}>
                  <span>{cell.label}</span>
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
