"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { BurgerIcon, IconButton } from "@/components/ui/IconButton";
import { CartButton } from "./CartButton";
import { useDrawer } from "./DrawerProvider";
import styles from "./Masthead.module.css";

type Props = {
  /** Wordmark. Changes per area: the shop, the member record, back of house. */
  name?: string;
  /** The small monospace line under it. */
  sub?: string;
  /** Replaces the bag button on the right, e.g. admin's Sign out. */
  right?: ReactNode;
};

export function Masthead({
  name = "Degenerates Inc.",
  sub = "Est. 2026 / Jacksonville NC",
  right,
}: Props) {
  const { open, openDrawer } = useDrawer();

  return (
    <header className={styles.masthead}>
      <IconButton
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls="main-drawer"
        onClick={openDrawer}
      >
        <BurgerIcon />
      </IconButton>

      <div className={styles.mark}>
        <div className={styles.seal} aria-hidden="true">
          D
        </div>
        <div>
          <div className={styles.name}>
            <Link href="/">{name}</Link>
          </div>
          <div className={styles.sub}>{sub}</div>
        </div>
      </div>

      <div className={styles.right}>
        {right ?? <CartButton />}
      </div>
    </header>
  );
}
