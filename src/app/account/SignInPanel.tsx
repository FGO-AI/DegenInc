"use client";

import { useState, type FormEvent } from "react";
import { BackLink, Button } from "@/components/ui/Button";
import { Field, Split } from "@/components/ui/Field";
import { Panel } from "@/components/ui/Panel";
import styles from "./SignInPanel.module.css";

/**
 * Member sign-in.
 *
 * Form only — no auth behind it yet. Wiring it up means calling
 * `supabase.auth.signInWithOtp` / `signInWithPassword`; see the README.
 */
export function SignInPanel() {
  const [status, setStatus] = useState("");

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("Accounts are not connected yet.");
  }

  return (
    <Panel
      title="Sign in"
      sub="Your certificate number and order history live here."
    >
      <form onSubmit={onSubmit}>
        <Field
          id="ac-email"
          label="Email"
          type="email"
          placeholder="you@wherever"
          autoComplete="email"
          required
        />
        <Field
          id="ac-pass"
          label="Password"
          type="password"
          placeholder="........"
          autoComplete="current-password"
          required
        />

        <Button type="submit">Sign in</Button>
        <Split>or</Split>
        <Button variant="ghost" onClick={() => setStatus("Accounts are not connected yet.")}>
          Create an account
        </Button>

        <p className={styles.status} role="status">
          {status}
        </p>
      </form>

      <BackLink href="/">Back to the shop</BackLink>
    </Panel>
  );
}
