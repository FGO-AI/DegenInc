import { Fragment, type ReactNode } from "react";
import styles from "./Certificate.module.css";
import { cx } from "./Layout";

export type CertRow = { term: string; value: ReactNode };

type Props = {
  title?: string;
  /** Printed top-right under "No." — the certificate number. */
  serial: string;
  rows: CertRow[];
  /** Fine print below the rule. */
  note?: ReactNode;
  className?: string;
};

/**
 * "Certificate of Degeneracy" — the object every order ships with. Rendered as
 * a definition list because that is exactly what it is: labelled record fields.
 */
export function Certificate({
  title = "Certificate of Degeneracy",
  serial,
  rows,
  note,
  className,
}: Props) {
  return (
    <div className={cx(styles.cert, "rough", "lit", className)}>
      <div className={styles.top}>
        <h3>{title}</h3>
        <div className={styles.serial}>
          No.
          <br />
          {serial}
        </div>
      </div>

      {/* dt/dd stay direct children of the dl: the two-column grid puts the
          label in the left cell and the value in the right, one row each. */}
      <dl>
        {rows.map((row) => (
          <Fragment key={row.term}>
            <dt>{row.term}</dt>
            <dd>{row.value}</dd>
          </Fragment>
        ))}
      </dl>

      {note && <p className={styles.note}>{note}</p>}
    </div>
  );
}
