import type { ReactNode } from "react";
import styles from "./Layout.module.css";

export const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(" ");

type SectionProps = {
  id?: string;
  /** `clear` shows the dither field through; `coal` is the lighter slab. */
  tone?: "ink" | "clear" | "coal";
  className?: string;
  children: ReactNode;
};

export function Section({ id, tone = "ink", className, children }: SectionProps) {
  return (
    <section
      id={id}
      className={cx(
        styles.section,
        tone === "clear" && styles.clear,
        tone === "coal" && styles.coal,
        className,
      )}
    >
      {children}
    </section>
  );
}

/** Centred 1240px measure. */
export function Wrap({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx(styles.wrap, className)}>{children}</div>;
}

/** Stacks on mobile, splits 50/50 from 900px. */
export function Cols({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx(styles.cols, className)}>{children}</div>;
}

/** Body-copy column: smoke-grey paragraphs under an eroded gothic heading. */
export function Prose({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx(styles.prose, className)}>{children}</div>;
}

/** A rule with a monospace label pinned at each end. */
export function Eyebrow({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className={styles.eyebrow}>
      <span className="mono">{left}</span>
      <span className="mono">{right}</span>
    </div>
  );
}
