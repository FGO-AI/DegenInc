import { Wrap } from "@/components/ui/Layout";
import styles from "./Hero.module.css";

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
      </Wrap>
    </section>
  );
}
