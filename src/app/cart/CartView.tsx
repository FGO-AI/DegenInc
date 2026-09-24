"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SignInPanel } from "@/app/account/SignInPanel";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Cols, Eyebrow, cx } from "@/components/ui/Layout";
import { Panel } from "@/components/ui/Panel";
import { useCart, type CartItem } from "@/lib/cart/CartProvider";
import { MAX_QUANTITY } from "@/lib/cart/limits";
import type { PurchaseResult } from "@/lib/db/checkout";
import type { CartLine, CartLineDetail } from "@/lib/db/queries";
import { money } from "@/lib/format";
import styles from "./page.module.css";

type Props = {
  signedIn: boolean;
  /** purchaseCart(), handed over by the server page. */
  placeOrder: (items: CartItem[]) => Promise<PurchaseResult>;
};

/** What the server said about the variants it was last asked about. */
type Answer = {
  asked: ReadonlySet<string>;
  lines: ReadonlyMap<string, CartLine>;
  /** Which refresh produced this answer. */
  round: number;
};

/**
 * The bag, joined against what is true now.
 *
 * The bag holds variant ids and quantities and nothing else, so everything a
 * buyer reads here — name, price, stock — is fetched fresh from /api/cart
 * (getCartDetails) whenever the set of variants changes, and again after a
 * failed order. Quantities are joined in on this side, so changing one never
 * waits on the network.
 */
export function CartView({ signedIn, placeOrder }: Props) {
  const { items, count, ready, setQuantity, removeItem, clear } = useCart();
  const router = useRouter();

  const [answer, setAnswer] = useState<Answer | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Bumped to re-read stock after a failed order, when the variants are the
  // same but what is left of them is not.
  const [round, setRound] = useState(0);

  const [pending, setPending] = useState(false);
  const [orderError, setOrderError] = useState("");
  const [placed, setPlaced] = useState(false);

  // Sorted, so only a different set of variants refetches — not a reorder,
  // and not a quantity change.
  const idsKey = items
    .map((i) => i.variantId)
    .sort()
    .join(",");

  useEffect(() => {
    if (!ready || !idsKey) return;
    const ids = idsKey.split(",");
    const controller = new AbortController();

    fetch(`/api/cart?${new URLSearchParams(ids.map((id) => ["v", id]))}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ lines: CartLine[] }>;
      })
      .then(({ lines }) => {
        setAnswer({
          asked: new Set(ids),
          lines: new Map(lines.map((l) => [l.variantId, l])),
          round,
        });
        setLoadFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });

    return () => controller.abort();
  }, [ready, idsKey, round]);

  /**
   * Current details for a line, or "gone" when there is nothing to show: the
   * server answers with a bare { variantId, available: false } for a variant
   * that was never on sale or does not exist, and those read the same here.
   */
  function detail(variantId: string): CartLineDetail | "gone" | "loading" {
    if (!answer || !answer.asked.has(variantId)) return "loading";
    const line = answer.lines.get(variantId);
    return line && "productName" in line ? line : "gone";
  }

  /**
   * Why this line cannot be ordered as it stands, or null when it can. The one
   * place a line is judged: the message under it, whether its quantity can
   * move, and whether it counts toward the subtotal all come from here.
   *
   * `blocked` is every case no quantity would fix — never on sale or gone,
   * filing closed, sold out. A short line is the exception: its fix is the
   * quantity control, so it stays live and keeps counting.
   */
  function problem(
    item: CartItem,
  ): { message: string; blocked: boolean } | null {
    const d = detail(item.variantId);
    if (d === "loading") return null;
    const blocked = (message: string) => ({ message, blocked: true });
    if (d === "gone") {
      return blocked("No longer available. Remove it to place your order.");
    }
    // Shown in full, like a short line: this was on sale, and the buyer should
    // see what they had when the drop ended.
    if (!d.available) {
      return blocked("This filing has closed. Remove it to place your order.");
    }
    if (d.stock === 0) return blocked("Sold out. Remove it to place your order.");
    if (d.stock < item.quantity) {
      return {
        message: `Only ${d.stock} left. Lower the quantity to place your order.`,
        blocked: false,
      };
    }
    return null;
  }

  async function submit() {
    setPending(true);
    setOrderError("");
    try {
      const result = await placeOrder(
        items.map(({ variantId, quantity }) => ({ variantId, quantity })),
      );
      if (result.ok) {
        setPlaced(true);
        clear();
        router.push("/account");
        return;
      }
      setOrderError(result.error);
      // Stock moved under us. Ask again so the short lines are marked.
      setRound((r) => r + 1);
    } catch {
      // No answer at all — a dropped connection, a server fault. The order may
      // or may not exist, and saying "nothing was ordered" could be false.
      setOrderError(
        "We could not confirm whether that order went through. Check your " +
          "record before placing it again.",
      );
    }
    setPending(false);
  }

  if (placed) {
    return (
      <EmptyState title="Order placed">
        Taking you to your record, where it is listed as pending.
      </EmptyState>
    );
  }

  // Until the stored bag has been read, "empty" would be a guess.
  if (!ready) {
    return <Eyebrow left="Your bag" right="..." />;
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="Your bag is empty"
        action={<ButtonLink href="/#filing">See the current filing</ButtonLink>}
      >
        Anything you pick from the current filing waits here, even if you close
        the tab.
      </EmptyState>
    );
  }

  const resolved = items.every((i) => detail(i.variantId) !== "loading");
  const problems = items.filter((i) => problem(i) !== null).length;
  // Only what could be ordered. A blocked line keeps its own total on screen
  // but adds nothing here; a short line still counts, at the quantity shown.
  const subtotal = items.reduce((sum, i) => {
    const d = detail(i.variantId);
    if (typeof d !== "object" || problem(i)?.blocked) return sum;
    return sum + d.priceCents * i.quantity;
  }, 0);

  // Place order only against stock read after the last failure, with every
  // line resolved and nothing short.
  const current = answer?.round === round && resolved && !loadFailed;
  const canOrder = current && problems === 0 && !pending;

  const orderHint = loadFailed
    ? "Current prices and stock could not be loaded, so the order cannot be checked yet."
    : !current
      ? "Checking current prices and stock..."
      : problems > 0
        ? `Fix the ${problems === 1 ? "line" : `${problems} lines`} marked in your bag to place this order.`
        : null;

  return (
    <Cols>
      <div>
        <Eyebrow
          left="Your bag"
          right={`${count} ${count === 1 ? "item" : "items"}`}
        />

        <ul className={cx(styles.lines, "rough")}>
          {items.map((item) => {
            const d = detail(item.variantId);
            const name =
              typeof d === "object"
                ? d.productName
                : d === "gone"
                  ? "Unavailable item"
                  : "...";
            const issue = problem(item);
            // Inert the way the product page's sold-out options are: the
            // buttons are `disabled`, so they take no click, no focus and no
            // key press — not merely drawn grey. Remove stays live; it is how
            // a blocked line leaves the bag.
            const frozen = issue?.blocked === true;

            return (
              <li key={item.variantId} className={styles.line}>
                <div className={styles.lineHead}>
                  <span className={styles.name}>{name}</span>
                  <span className={styles.total}>
                    {typeof d === "object"
                      ? money(d.priceCents * item.quantity)
                      : d === "gone"
                        ? "—"
                        : "..."}
                  </span>
                </div>

                {typeof d === "object" && (
                  <p className={cx("mono", styles.meta)}>
                    {d.size} / {d.color} / {money(d.priceCents)} each
                  </p>
                )}

                <div className={styles.controls}>
                  <div
                    className={styles.stepper}
                    role="group"
                    aria-label={`Quantity of ${name}`}
                  >
                    <button
                      type="button"
                      aria-label={`One fewer ${name}`}
                      disabled={frozen || item.quantity <= 1 || pending}
                      onClick={() =>
                        setQuantity(item.variantId, item.quantity - 1)
                      }
                    >
                      {"−"}
                    </button>
                    <output aria-live="polite">{item.quantity}</output>
                    <button
                      type="button"
                      aria-label={`One more ${name}`}
                      disabled={
                        frozen || item.quantity >= MAX_QUANTITY || pending
                      }
                      onClick={() =>
                        setQuantity(item.variantId, item.quantity + 1)
                      }
                    >
                      +
                    </button>
                  </div>

                  <button
                    type="button"
                    className={styles.remove}
                    disabled={pending}
                    onClick={() => removeItem(item.variantId)}
                  >
                    Remove
                  </button>
                </div>

                {issue && <p className={styles.issue}>{issue.message}</p>}
              </li>
            );
          })}
        </ul>

        <div className={styles.subtotal}>
          <span className="mono">Subtotal</span>
          <span className={styles.total}>
            {resolved ? money(subtotal) : "..."}
          </span>
        </div>
      </div>

      <div>
        {signedIn ? (
          <Panel
            title="Place order"
            sub="Stock is set aside for you the moment the order goes in."
          >
            <Button
              className={styles.place}
              disabled={!canOrder}
              onClick={submit}
            >
              {pending ? "..." : "Place order"}
            </Button>
            {orderHint && !pending && (
              <p className={styles.hint}>{orderHint}</p>
            )}
            {loadFailed && (
              <Button
                variant="ghost"
                className={styles.retry}
                onClick={() => setRound((r) => r + 1)}
              >
                Try loading again
              </Button>
            )}
            <p className={styles.status} role="status">
              {orderError}
            </p>
          </Panel>
        ) : (
          <>
            {/* Inline, not a redirect: the buyer stays on this page with the
                bag in front of them, and it becomes "Place order" once they
                are in. See page.tsx. */}
            <p className={styles.lead}>
              Sign in or enrol to place this order. Your bag stays exactly as
              it is.
            </p>
            <SignInPanel />
          </>
        )}
      </div>
    </Cols>
  );
}
