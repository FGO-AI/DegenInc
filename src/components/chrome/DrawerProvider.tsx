"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type DrawerValue = {
  open: boolean;
  openDrawer: () => void;
  /**
   * Close because something else is taking over the screen — a navigation.
   * Leaves focus alone: the App Router moves it to the new page.
   */
  closeDrawer: () => void;
  /**
   * Close in place — the scrim, the Close button, Escape. Hands focus back to
   * whatever opened the drawer.
   */
  dismissDrawer: () => void;
};

const DrawerContext = createContext<DrawerValue | null>(null);

/**
 * Owns the one piece of state shared across the whole app: whether the nav
 * drawer is open. The masthead on every page opens it; the drawer itself and
 * the Escape key close it.
 */
export function DrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  // Where focus was before the drawer took it, so we can hand it back.
  const restoreTo = useRef<HTMLElement | null>(null);

  const openDrawer = useCallback(() => {
    const active = document.activeElement;
    // <body> is not focusable, so storing it would make dismiss a silent
    // no-op. Better to record nothing and leave focus where the browser has
    // it.
    restoreTo.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    setOpen(true);
  }, []);

  /**
   * Close on the way to somewhere else.
   *
   * No focus restore, on purpose: this runs from a nav link's own click
   * handler, and the element we stored — the masthead burger — is about to
   * unmount with the outgoing page. Calling .focus() on a detached node
   * silently does nothing and focus ends up on <body>, which is the "lands
   * nowhere" this avoids. The App Router already moves focus to the new
   * segment, so the correct move is to stay out of its way.
   *
   * Dropping the ref matters as much as skipping the focus: left set, it
   * would point at a node from the previous page and swallow a later dismiss.
   */
  const closeDrawer = useCallback(() => {
    setOpen(false);
    restoreTo.current = null;
  }, []);

  /**
   * Close without going anywhere.
   *
   * The .focus() is synchronous, in the same tick as setOpen(false), and that
   * ordering is load-bearing rather than accidental. React has not committed
   * yet, so the wrapper is still non-inert and visible; focus lands on the
   * masthead button, which sits outside the wrapper and is unaffected by
   * either. Deferring it — to an effect, or a rAF — would let React commit
   * `inert` and `visibility: hidden` while focus was still on a link inside
   * the drawer, and the browser would blow focus out to <body> before the
   * restore ever ran.
   */
  const dismissDrawer = useCallback(() => {
    setOpen(false);
    const target = restoreTo.current;
    restoreTo.current = null;
    // isConnected guards the case where the opener unmounted for some other
    // reason while the drawer was up.
    if (target?.isConnected) target.focus();
  }, []);

  // Navigation closes the drawer from the link's own click handler (see
  // NavLink in Drawer.tsx) rather than from a pathname effect — that also
  // covers links pointing at the route you're already on, which never fire a
  // navigation at all.

  // Lock the page behind the scrim while it's open.
  //
  // The offset is the whole point. body.locked takes the body out of flow,
  // which is the only thing iOS Safari reliably respects — but that alone
  // snaps the page to the top, so closing the drawer would dump the reader
  // somewhere else in the document. Pinning `top` to minus the scroll
  // position holds the view still, and scrolling back to it on close returns
  // them exactly where they were.
  useEffect(() => {
    if (!open) return;

    const y = window.scrollY;
    const body = document.body;
    body.classList.add("locked");
    body.style.top = `-${y}px`;

    return () => {
      body.classList.remove("locked");
      body.style.top = "";
      // "instant" is load-bearing: html has scroll-behavior: smooth, so a
      // plain scrollTo would animate the restore and read as jank.
      window.scrollTo({ top: y, behavior: "instant" });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape is a dismissal, not a navigation.
      if (e.key === "Escape") dismissDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dismissDrawer]);

  // Memoised so the value's identity tracks `open` rather than every render.
  const value = useMemo(
    () => ({ open, openDrawer, closeDrawer, dismissDrawer }),
    [open, openDrawer, closeDrawer, dismissDrawer],
  );

  return (
    <DrawerContext.Provider value={value}>{children}</DrawerContext.Provider>
  );
}

export function useDrawer() {
  const ctx = useContext(DrawerContext);
  if (!ctx) throw new Error("useDrawer must be used inside <DrawerProvider>");
  return ctx;
}
