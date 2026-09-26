"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cx } from "@/components/ui/Layout";
import { useCart } from "@/lib/cart/CartProvider";
import { MAX_LINES, MAX_QUANTITY } from "@/lib/cart/limits";
import type { ProductVariant } from "@/lib/db/queries";
import styles from "./page.module.css";

type Props = {
  productName: string;
  variants: ProductVariant[];
};

/** Distinct values, in first-seen order — the order staff entered them. */
const distinct = (values: string[]) => [...new Set(values)];

/**
 * Size, then color, then into the bag.
 *
 * A combination with nothing left cannot be chosen, not merely drawn grey: its
 * radio is `disabled`, so neither a click nor the arrow keys can select it.
 *
 * The two axes are not symmetric, on purpose. A size is disabled only when it
 * is gone in every color; a color is disabled when it is gone in the chosen
 * size. Constraining each by the other would strand a buyer: with M / Black
 * chosen, L (gone in black) and White (gone in M) would both be locked, and
 * L / White — in stock — would be unreachable. Picking a size instead moves the
 * color to one that size has, so the choice on screen is always something that
 * can be bought.
 *
 * Stock is as of page load. The bag page re-reads it, and checkout decides.
 */
export function VariantPicker({ productName, variants }: Props) {
  const { items, ready, addItem } = useCart();
  const id = useId();

  const sizes = distinct(variants.map((v) => v.size));
  const colors = distinct(variants.map((v) => v.color));

  const find = (size: string | null, color: string | null) =>
    variants.find((v) => v.size === size && v.color === color);
  const left = (size: string | null, color: string) =>
    find(size, color)?.stock ?? 0;

  // Open on the first combination that can actually be bought.
  const first = variants.find((v) => v.stock > 0);
  const [size, setSize] = useState(first?.size ?? null);
  const [color, setColor] = useState(first?.color ?? null);

  // The last thing added. `n` re-keys the slip so its stamp presses again.
  const [filed, setFiled] = useState<{ n: number; variant: ProductVariant } | null>(
    null,
  );

  const chosen = find(size, color);
  const inBag = chosen
    ? (items.find((i) => i.variantId === chosen.id)?.quantity ?? 0)
    : 0;

  // Before the stored bag is read (`ready`), what is in it is unknown, so the
  // bag-dependent limits wait for it rather than guessing.
  const blocked =
    variants.length === 0
      ? "Not yet available"
      : !chosen || chosen.stock === 0
        ? "Sold out"
        : ready && inBag >= Math.min(chosen.stock, MAX_QUANTITY)
          ? "All in your bag"
          : ready && inBag === 0 && items.length >= MAX_LINES
            ? "Your bag is full"
            : null;

  function pickSize(next: string) {
    setSize(next);
    if (left(next, color ?? "") === 0) {
      // Disabled sizes cannot get here, so this size has some color left.
      setColor(colors.find((c) => left(next, c) > 0) ?? null);
    }
  }

  function add() {
    // The button is disabled whenever `blocked` is set. Checked again here so
    // nothing — a stale render, a scripted click — puts a combination with
    // nothing left in the bag.
    if (blocked || !chosen || chosen.stock <= inBag) return;
    addItem(chosen.id);
    setFiled((f) => ({ n: (f?.n ?? 0) + 1, variant: chosen }));
  }

  return (
    <div className={styles.picker}>
      <fieldset className={styles.axis}>
        <legend>Size</legend>
        <div className={styles.options}>
          {sizes.map((s) => {
            const gone = !colors.some((c) => left(s, c) > 0);
            return (
              <label key={s} className={styles.option}>
                <input
                  type="radio"
                  name={`${id}-size`}
                  value={s}
                  checked={size === s}
                  disabled={gone}
                  onChange={() => pickSize(s)}
                />
                <span>
                  {s}
                  {gone && <span className={styles.hidden}>, sold out</span>}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className={styles.axis}>
        <legend>Color</legend>
        <div className={styles.options}>
          {colors.map((c) => {
            const gone = left(size, c) === 0;
            return (
              <label key={c} className={styles.option}>
                <input
                  type="radio"
                  name={`${id}-color`}
                  value={c}
                  checked={color === c}
                  disabled={gone}
                  onChange={() => setColor(c)}
                />
                <span>
                  {c}
                  {gone && (
                    <span className={styles.hidden}>
                      , {find(size, c) ? "sold out" : "not made"} in {size}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <p className={cx("mono", styles.summary)}>
        {chosen && chosen.stock > 0 ? (
          <>
            {chosen.size} / {chosen.color} <b>/ {chosen.stock} left</b>
            {ready && inBag > 0 && <> / {inBag} in your bag</>}
          </>
        ) : variants.length > 0 ? (
          "Sold out in every size"
        ) : (
          "No sizes on file yet"
        )}
      </p>

      <Button className={styles.add} disabled={blocked !== null} onClick={add}>
        {blocked ?? "Add to bag"}
      </Button>

      {/* Always in the DOM, so screen readers are already listening when the
          slip appears inside it. */}
      <div role="status">
        {filed && (
          <div key={filed.n} className={cx(styles.slip, "rough", "lit")}>
            <span className={cx(styles.stamp, "eroded")} aria-hidden="true">
              Filed
            </span>
            <div>
              <p className="mono">Entered in your bag</p>
              <p className={styles.slipLine}>
                {productName} / {filed.variant.size} / {filed.variant.color}
              </p>
              <Link href="/cart" className={styles.bagLink}>
                View your bag
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
