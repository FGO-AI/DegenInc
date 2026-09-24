import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";
import styles from "./IconButton.module.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement>;

/** Bordered 44px control used in the masthead and the drawer header. */
export function IconButton({ className, children, ...rest }: Props) {
  return (
    <button
      type="button"
      className={[styles.iconbtn, className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Same control, but it navigates — the bag in the masthead goes to /cart. */
export function IconButtonLink({
  className,
  children,
  ...rest
}: ComponentProps<typeof Link>) {
  return (
    <Link
      className={[styles.iconbtn, className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </Link>
  );
}

/** The hamburger glyph. Three rules, inherits the button's colour. */
export function BurgerIcon() {
  return (
    <span className={styles.burger} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
