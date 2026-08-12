import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import styles from "./Field.module.css";

type Common = {
  id: string;
  label: string;
  /** Small grey note under the control. */
  hint?: string;
};

type FieldProps = Common & InputHTMLAttributes<HTMLInputElement>;

/** Labelled text input. The label is always rendered — no placeholder-as-label. */
export function Field({ id, label, hint, ...rest }: FieldProps) {
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...rest} />
      {hint && (
        <div id={`${id}-hint`} className={styles.hint}>
          {hint}
        </div>
      )}
    </div>
  );
}

type TextFieldProps = Common & TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextAreaField({ id, label, hint, ...rest }: TextFieldProps) {
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...rest}
      />
      {hint && (
        <div id={`${id}-hint`} className={styles.hint}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** Centred monospace divider, e.g. "or". */
export function Split({ children }: { children: React.ReactNode }) {
  return <div className={styles.split}>{children}</div>;
}
