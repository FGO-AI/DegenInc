"use client";

import { IconButtonLink } from "@/components/ui/IconButton";
import { useCart } from "@/lib/cart/CartProvider";

/**
 * The bag in the masthead: total units, linking to /cart.
 *
 * Reads the shared cart store, so every Masthead on screen shows the same
 * number and changes in the same render as the bag does. Before hydration the
 * stored bag has not been read yet, so it shows 0 — what this spot always
 * rendered — rather than a guess.
 */
export function CartButton() {
  const { count, ready } = useCart();
  const shown = ready ? count : 0;

  return (
    <IconButtonLink
      href="/cart"
      aria-label={`Your bag, ${shown} ${shown === 1 ? "item" : "items"}`}
    >
      {shown}
    </IconButtonLink>
  );
}
