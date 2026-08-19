"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { BackLink, Button } from "@/components/ui/Button";
import { Field, Split } from "@/components/ui/Field";
import { Panel } from "@/components/ui/Panel";
import { signIn, signUp } from "@/lib/auth/client";
import styles from "./SignInPanel.module.css";

type Mode = "signin" | "signup";

/**
 * Member sign-in and enrolment.
 *
 * Talks to /api/auth/*, never to the database — there is no public database
 * endpoint. The `role` column is deliberately not settable from here; Better
 * Auth is configured with `input: false` on it, so a crafted sign-up payload
 * cannot make anyone staff.
 */
export function SignInPanel() {
  const [mode, setMode] = useState<Mode>("signin");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setStatus("");

    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "") || email.split("@")[0];

    const { error } =
      mode === "signup"
        ? await signUp.email({ email, password, name })
        : await signIn.email({ email, password });

    setPending(false);

    if (error) {
      setStatus(error.message ?? "That did not work.");
      return;
    }

    // refresh() re-runs the server components so the record reflects the
    // new session rather than the signed-out shell.
    router.refresh();
  }

  return (
    <Panel
      title={mode === "signin" ? "Sign in" : "Enrol"}
      sub="Your certificate number and order history live here."
    >
      <form onSubmit={onSubmit}>
        {mode === "signup" && (
          <Field
            id="ac-name"
            name="name"
            label="Name or tag"
            type="text"
            placeholder="How you sign it"
            autoComplete="nickname"
          />
        )}

        <Field
          id="ac-email"
          name="email"
          label="Email"
          type="email"
          placeholder="you@wherever"
          autoComplete="email"
          required
        />
        <Field
          id="ac-pass"
          name="password"
          label="Password"
          type="password"
          placeholder="........"
          autoComplete={
            mode === "signup" ? "new-password" : "current-password"
          }
          minLength={8}
          required
        />

        <Button type="submit" disabled={pending}>
          {pending ? "..." : mode === "signin" ? "Sign in" : "Create account"}
        </Button>

        <Split>or</Split>

        <Button
          variant="ghost"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setStatus("");
          }}
        >
          {mode === "signin" ? "Create an account" : "I already have one"}
        </Button>

        <p className={styles.status} role="status">
          {status}
        </p>
      </form>

      <BackLink href="/">Back to the shop</BackLink>
    </Panel>
  );
}
