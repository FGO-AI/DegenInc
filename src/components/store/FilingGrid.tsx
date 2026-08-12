import Link from "next/link";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow, Section, Wrap, cx } from "@/components/ui/Layout";
import styles from "./FilingGrid.module.css";

/**
 * Filing 001. Four reserved slots with no assets behind them yet — the grid is
 * deliberately visible before there is anything to show, so the shape of the
 * drop is legible from day one.
 */
const SLOTS = [
  { slot: "01", kind: "Tee" },
  { slot: "02", kind: "Tee" },
  { slot: "03", kind: "Hood" },
  { slot: "04", kind: "Reserved" },
];

export function FilingGrid() {
  return (
    <Section id="filing">
      <Wrap>
        <Eyebrow
          left={
            <>
              Filing 001 <b>/ unscheduled</b>
            </>
          }
          right="Form DI-11"
        />

        <div className={styles.grid}>
          {SLOTS.map((item) => (
            <Link key={item.slot} href="/soon" className={styles.slot}>
              <div className={cx(styles.frame, "rough")}>
                <span>
                  Slot {item.slot}
                  <br />
                  awaiting asset
                </span>
              </div>
              <div className={styles.meta}>
                <span>{item.kind}</span>
                <span className={styles.price}>TBD</span>
              </div>
            </Link>
          ))}
        </div>

        <div className={styles.overflow}>
          <EmptyState
            title="Nothing is live yet"
            action={<ButtonLink href="/account">Get on the list</ButtonLink>}
          >
            The first filing has not posted. When it does, members see it two
            days before anyone else and the run sells out or it does not.
          </EmptyState>
        </div>
      </Wrap>
    </Section>
  );
}
