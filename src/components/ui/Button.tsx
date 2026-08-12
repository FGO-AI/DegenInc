import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";
import { cx } from "./Layout";

type Variant = "solid" | "ghost";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  /** Shrink to content instead of filling the row. For toolbars. */
  compact?: boolean;
};

const variantClass = (variant: Variant) =>
  cx(styles.btn, variant === "ghost" && styles.ghost);

export function Button({
  variant = "solid",
  compact,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(variantClass(variant), compact && styles.compact, className)}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Same look, but it navigates. */
export function ButtonLink({
  href,
  variant = "solid",
  compact,
  className,
  children,
}: {
  href: string;
  variant?: Variant;
  compact?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cx(variantClass(variant), compact && styles.compact, className)}
    >
      {children}
    </Link>
  );
}

/** The small underlined "take me back" link under a panel. */
export function BackLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={styles.backlink}>
      {children}
    </Link>
  );
}
