import styles from "./Overlays.module.css";

/** Film grain + CRT scanlines, layered over the dither field. */
export function Overlays() {
  return (
    <>
      <div className={styles.grain} aria-hidden="true" />
      <div className={styles.scan} aria-hidden="true" />
    </>
  );
}
