import Link from "next/link";
import { Prose, Section, Wrap, cx } from "@/components/ui/Layout";
import styles from "./Gallery.module.css";

/**
 * The homepage gallery block: a heading, a line of copy and an empty frame,
 * all inside one link.
 *
 * The whole box is the target rather than a button in the corner of it —
 * there is nothing else in this section to click, so a dead zone around the
 * copy would only be a place to miss.
 */
export function Gallery() {
  return (
    <Section tone="clear">
      <Wrap>
        <Link href="/gallery" className={styles.block}>
          <Prose>
            <h2 className="eroded">Gallery</h2>
            <p>
              Product shots, fit pictures, and whatever else gets documented.
              Nothing has been shot yet.
            </p>
          </Prose>

          <div className={cx(styles.frame, "rough")}>
            <span>awaiting photography</span>
          </div>
        </Link>
      </Wrap>
    </Section>
  );
}
