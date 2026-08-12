import type { ReactNode } from "react";
import styles from "./Panel.module.css";
import { cx } from "./Layout";

type Props = {
  title?: string;
  /** Grey line under the title. */
  sub?: string;
  className?: string;
  children: ReactNode;
};

/** Bordered card, roughed edges, usually wrapping a form. */
export function Panel({ title, sub, className, children }: Props) {
  return (
    <div className={cx(styles.panel, "rough", className)}>
      {title && <h2>{title}</h2>}
      {sub && <p className={styles.sub}>{sub}</p>}
      {children}
    </div>
  );
}
