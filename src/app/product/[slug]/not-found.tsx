import { Masthead } from "@/components/chrome/Masthead";
import { ButtonLink } from "@/components/ui/Button";
import styles from "./page.module.css";

/**
 * What /product/<slug> renders, with a 404, for anything not on a live filing.
 *
 * A slug that was never used, a product still in draft or scheduled, and one
 * from a closed filing all land here with the same words. Telling them apart
 * would announce which unreleased products exist.
 */
export default function ProductNotFound() {
  return (
    <>
      <Masthead />
      <section className={styles.missing}>
        <h1 className="eroded">Not on file</h1>
        <p className="mono">Nothing by that name is on the current filing.</p>
        <ButtonLink href="/#filing" compact>
          See the current filing
        </ButtonLink>
      </section>
    </>
  );
}
