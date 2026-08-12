import type { Metadata } from "next";
import { Masthead } from "@/components/chrome/Masthead";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "In Production",
};

/**
 * Holding page. Every category and product link points here until Filing 001
 * actually posts — one honest dead end instead of a dozen empty listings.
 */
export default function SoonPage() {
  return (
    <>
      <Masthead />
      <section className={styles.holding}>
        <h1 className="eroded">In Production</h1>
      </section>
    </>
  );
}
