import { Wrap } from "@/components/ui/Layout";
import styles from "./Hero.module.css";

/** The status board under the headline. Placeholder values until launch. */
const STATUS = [
  { term: "Status", value: "Pre launch" },
  { term: "Next filing", value: "Unscheduled" },
  { term: "Members", value: "Enrolling" },
  { term: "Submissions", value: "Open" },
];

export function Hero() {
  return (
    <section className={styles.hero}>
      <Wrap>
        <h1 className="eroded">
          Degenerates
          <span className={styles.thin}>Incorporated</span>
        </h1>

        <p className={styles.lede}>
          Clothing is how we translate the <em>inside, outside</em>. Everything
          here gets printed in small runs, then it&rsquo;s gone.
        </p>

        <dl className={styles.herofoot}>
          {STATUS.map((item) => (
            <div key={item.term}>
              <dt>{item.term}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      </Wrap>
    </section>
  );
}
