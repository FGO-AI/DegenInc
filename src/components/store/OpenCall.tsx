"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field, TextAreaField } from "@/components/ui/Field";
import { Cols, Prose, Section, Wrap } from "@/components/ui/Layout";
import { Panel } from "@/components/ui/Panel";
import styles from "./OpenCall.module.css";

/**
 * Artist submission form.
 *
 * The markup and validation are real; the destination is not. Wiring it up means
 * inserting into a `submissions` table — see "Wiring the backend" in the README.
 */
export function OpenCall() {
  const [status, setStatus] = useState("");

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("Not connected yet — no submission was sent.");
  }

  return (
    <Section id="opencall" tone="coal">
      <Wrap>
        <Cols>
          <Prose>
            <h2 className="eroded">Open call</h2>
            <p>
              Send us a design. Graffiti, flash sheets, photos, whatever you
              make. If it gets printed you get credit on the piece and a cut of
              the run.
            </p>
            <p>We read everything. We answer slower than we should.</p>
          </Prose>

          <Panel>
            <form onSubmit={onSubmit} noValidate={false}>
              <Field
                id="oc-name"
                label="Name or tag"
                type="text"
                placeholder="How you sign it"
                autoComplete="nickname"
                required
              />
              <Field
                id="oc-contact"
                label="Where to reach you"
                type="text"
                placeholder="Email or handle"
                required
              />
              <Field
                id="oc-work"
                label="Link to your work"
                type="url"
                placeholder="Portfolio, drive folder, IG"
                hint="Anything we can open without an account."
                required
              />
              <TextAreaField
                id="oc-note"
                label="What is it"
                rows={3}
                placeholder="A sentence is fine"
              />

              <Button type="submit">Send it in</Button>

              <p className={styles.status} role="status">
                {status}
              </p>
            </form>
          </Panel>
        </Cols>
      </Wrap>
    </Section>
  );
}
