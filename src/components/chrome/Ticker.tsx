import styles from "./Ticker.module.css";

const PHRASES = [
  "Filing 001 posts without notice",
  "Members get 48 hours first",
  "Submissions open to anyone",
  "Print runs are small on purpose",
];

/**
 * Marquee under the masthead. The phrase list is rendered twice so the -50%
 * translate loops seamlessly; the whole thing is aria-hidden because a moving
 * strip of slogans is noise to a screen reader, and none of it is unique
 * information.
 */
export function Ticker() {
  return (
    <div className={styles.ticker} aria-hidden="true">
      <div className={styles.run}>
        {[0, 1].map((copy) =>
          PHRASES.map((phrase) => <span key={`${copy}-${phrase}`}>{phrase}</span>),
        )}
      </div>
    </div>
  );
}
