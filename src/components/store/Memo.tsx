import { Fragment } from "react";
import { Section, Wrap, cx } from "@/components/ui/Layout";
import styles from "./Memo.module.css";

const HEADER = [
  { term: "To", value: "Anyone who reads this far" },
  { term: "From", value: "The desk of nobody in particular" },
  { term: "Re", value: "Why this exists" },
];

/** The charter, dressed as a photocopied internal memo. */
export function Memo() {
  return (
    <Section id="memo" tone="clear">
      <Wrap>
        <div className={cx(styles.memo, "torn")}>
          <div className={styles.stamp} aria-hidden="true">
            Void
          </div>

          <div className={cx("mono", styles.kicker)}>Internal memorandum</div>
          <div className={styles.rule} />
          <h2>On fitting in</h2>
          <div className={styles.rule} />

          <dl>
            {HEADER.map((row) => (
              <Fragment key={row.term}>
                <dt>{row.term}</dt>
                <dd>{row.value}</dd>
              </Fragment>
            ))}
          </dl>

          <p>
            Most people spend their whole life sanding themselves down to fit a
            shape somebody else picked. We are not interested in that. This is
            for the ones who were already going against the grain before it had
            a name, and who kept going after everyone told them to quit.
          </p>
          <p>
            You do not have to skate, paint, ride, lift, or play anything. There
            is one requirement and it is that you are actually yourself.
          </p>

          <div className={styles.sig}>
            Filed under: charter / not enforceable / never revised
          </div>
        </div>
      </Wrap>
    </Section>
  );
}
