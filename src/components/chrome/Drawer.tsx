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
  { label: "Gallery", href: "/gallery" },
  { label: "Open call", href: "/#opencall" },
  { label: "About", href: "/about" },
];

const FOCUSABLE =
  'a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])';

/**
 * A drawer link. It closes the drawer from its own click rather than from a
 * route-change effect, so links pointing at the route you're already on still
 * dismiss it.
 *
 * `onNavigate`, not `onClose`: this path deliberately does not restore focus,
 * because the page underneath is being replaced.
 */
function NavLink({
  href,
  onNavigate,
  children,
}: {
  href: string;
  onNavigate: () => void;
  children: ReactNode;
}) {
  return (
    <Link href={href} onClick={onNavigate}>
      {children}
    </Link>
  );
}

export function Drawer() {
  const { open, closeDrawer, dismissDrawer } = useDrawer();
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
      {/* Decorative: the header Close button is the real control, and this
          carrying the same label meant a screen reader announced two
          identical "Close menu" controls. Already tabIndex={-1}, so hiding it
          leaves nothing focusable inside an aria-hidden subtree. */}
      <button
        type="button"
        className={styles.scrim}
        onClick={dismissDrawer}
        tabIndex={-1}
        aria-hidden="true"
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
          <IconButton onClick={dismissDrawer} aria-label="Close menu">
            Close
          </IconButton>
        </div>

        <div className={styles.body}>
          <div className={`${styles.group} ${styles.split2}`}>
            <div className={styles.label}>Shop by</div>
            <NavLink href="/soon" onNavigate={closeDrawer}>
              Men
            </NavLink>
            <NavLink href="/soon" onNavigate={closeDrawer}>
              Women
            </NavLink>
          </div>

          <div className={styles.group}>
            <div className={styles.label}>Categories</div>
            {CATEGORIES.map((c) => (
              <NavLink key={c} href="/soon" onNavigate={closeDrawer}>
                {c}
              </NavLink>
            ))}
          </div>

          <div className={styles.group}>
            <div className={styles.label}>The house</div>
            {HOUSE.map((item) => (
              <NavLink key={item.label} href={item.href} onNavigate={closeDrawer}>
                {item.label}
              </NavLink>
            ))}
          </div>

          <div className={styles.group}>
            <div className={styles.label}>You</div>
            <NavLink href="/account" onNavigate={closeDrawer}>
              Sign in
            </NavLink>
            <NavLink href="/account" onNavigate={closeDrawer}>
              Your certificate
            </NavLink>
          </div>
        </div>

        <div className={styles.staff}>
          <p>Do you work here?</p>
          <NavLink href="/admin" onNavigate={closeDrawer}>
            Staff sign in
          </NavLink>
        </div>
      </nav>
    </div>
  );
}
