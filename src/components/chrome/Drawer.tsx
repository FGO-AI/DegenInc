"use client";

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { IconButton } from "@/components/ui/IconButton";
import { useDrawer } from "./DrawerProvider";
import styles from "./Drawer.module.css";

/** Categories that have no filing behind them yet all land on /soon. */
const CATEGORIES = ["Tees", "Hoodies", "Outerwear", "Headwear", "Accessories"];

const HOUSE = [
  { label: "Current filing", href: "/#filing" },
  { label: "The collective", href: "/#collective" },
  { label: "Open call", href: "/#opencall" },
  { label: "Charter", href: "/#memo" },
];

const FOCUSABLE =
  'a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])';

/**
 * A drawer link. It closes the drawer from its own click rather than from a
 * route-change effect, so links pointing at the route you're already on still
 * dismiss it.
 */
function NavLink({
  href,
  onClose,
  children,
}: {
  href: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Link href={href} onClick={onClose}>
      {children}
    </Link>
  );
}

export function Drawer() {
  const { open, closeDrawer } = useDrawer();
  const panelRef = useRef<HTMLElement>(null);

  // Move focus into the panel on open, and keep Tab inside it while it's up.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    panel.querySelector<HTMLElement>(`.${styles.group} a`)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      // Wrap at both ends so focus never escapes to the page behind the scrim.
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div
      id="main-drawer"
      className={`${styles.drawer} ${open ? styles.open : ""}`}
      // Hidden from assistive tech when closed; it's still in the DOM so the
      // panel can slide rather than pop. `inert` also takes it out of the tab
      // order, which visibility:hidden alone does not guarantee mid-transition.
      aria-hidden={!open}
      inert={!open}
    >
      <button
        type="button"
        className={styles.scrim}
        onClick={closeDrawer}
        tabIndex={-1}
        aria-label="Close menu"
      />

      <nav
        ref={panelRef}
        className={styles.panel}
        aria-label="Main menu"
        aria-modal={open || undefined}
        role={open ? "dialog" : undefined}
      >
        <div className={styles.head}>
          <span className={styles.title}>Menu</span>
          <IconButton onClick={closeDrawer} aria-label="Close menu">
            Close
          </IconButton>
        </div>

        <div className={styles.body}>
          <div className={`${styles.group} ${styles.split2}`}>
            <div className={styles.label}>Shop by</div>
            <NavLink href="/soon" onClose={closeDrawer}>
              Men
            </NavLink>
            <NavLink href="/soon" onClose={closeDrawer}>
              Women
            </NavLink>
          </div>

          <div className={styles.group}>
            <div className={styles.label}>Categories</div>
            {CATEGORIES.map((c) => (
              <NavLink key={c} href="/soon" onClose={closeDrawer}>
                {c}
              </NavLink>
            ))}
          </div>

          <div className={styles.group}>
            <div className={styles.label}>The house</div>
            {HOUSE.map((item) => (
              <NavLink key={item.label} href={item.href} onClose={closeDrawer}>
                {item.label}
              </NavLink>
            ))}
          </div>

          <div className={styles.group}>
            <div className={styles.label}>You</div>
            <NavLink href="/account" onClose={closeDrawer}>
              Sign in
            </NavLink>
            <NavLink href="/account" onClose={closeDrawer}>
              Your certificate
            </NavLink>
          </div>
        </div>

        <div className={styles.staff}>
          <p>Do you work here?</p>
          <NavLink href="/admin" onClose={closeDrawer}>
            Staff sign in
          </NavLink>
        </div>
      </nav>
    </div>
  );
}
