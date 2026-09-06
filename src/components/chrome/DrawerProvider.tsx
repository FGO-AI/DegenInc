"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type DrawerValue = {
  open: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
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
    restoreTo.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setOpen(false);
    // Return focus to whatever opened the drawer, or the user is dumped at
    // the top of the document with no idea where they are.
    restoreTo.current?.focus?.();
    restoreTo.current = null;
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
      if (e.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closeDrawer]);

  return (
    <DrawerContext.Provider value={{ open, openDrawer, closeDrawer }}>
      {children}
    </DrawerContext.Provider>
  );
}

export function useDrawer() {
  const ctx = useContext(DrawerContext);
  if (!ctx) throw new Error("useDrawer must be used inside <DrawerProvider>");
  return ctx;
}
