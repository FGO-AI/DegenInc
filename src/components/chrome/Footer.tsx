import Link from "next/link";
import type { ReactNode } from "react";
import { Wrap } from "@/components/ui/Layout";
import styles from "./Footer.module.css";

type FooterProps = {
  /** Left-hand label in the closing strip. */
  note: string;
  /** Right-hand form number. */
  form: string;
  /** Optional link columns, rendered above the strip. */
  children?: ReactNode;
};

/**
 * Every page closes on a form-number strip. The storefront adds three link
 * columns above it; the account and admin pages just get the strip.
 */
export function Footer({ note, form, children }: FooterProps) {
  return (
    <footer className={styles.footer}>
      <Wrap>
        {children}
        <div className={styles.formno}>
          <span className="mono">{note}</span>
          <span className="mono">{form}</span>
        </div>
      </Wrap>
    </footer>
  );
}

const COLUMNS = [
  {
    heading: "Shop",
    links: [
      { label: "Men", href: "/soon" },
      { label: "Women", href: "/soon" },
      { label: "Size guide", href: "/soon" },
    ],
  },
  {
    heading: "Look",
    links: [
      { label: "Gallery", href: "/gallery" },
      { label: "Current filing", href: "/#filing" },
      { label: "Submit a design", href: "/#opencall" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Shipping and returns", href: "/soon" },
      { label: "Contact", href: "/soon" },
    ],
  },
];

/** The full storefront footer: three link columns over the form strip. */
export function StoreFooter() {
  return (
    <Footer note="Interface mockup / no live data" form="Form DI-00 / rev. 2026">
      <div className={styles.grid}>
        {COLUMNS.map((col) => (
          <div key={col.heading}>
            <h4>{col.heading}</h4>
            {col.links.map((link) => (
              <Link key={link.label} href={link.href}>
                {link.label}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </Footer>
  );
}
