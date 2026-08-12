import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";
import { cx } from "./Layout";

type Props = {
  title: string;
  children: ReactNode;
  /** Optional call to action, centred and width-capped below the copy. */
  action?: ReactNode;
  className?: string;
};

/**
 * "Nothing is live yet" / "No orders" / "Nothing in the queue". This site is
 * pre-launch, so the empty state is the primary state — it gets a real voice
 * rather than a shrug.
 */
export function EmptyState({ title, children, action, className }: Props) {
  return (
    <div className={cx(styles.empty, "rough", className)}>
      <h3>{title}</h3>
      <p>{children}</p>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
