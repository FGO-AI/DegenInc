import type { Metadata } from "next";
import { Footer } from "@/components/chrome/Footer";
import { Masthead } from "@/components/chrome/Masthead";
import { Certificate } from "@/components/ui/Certificate";
import { EmptyState } from "@/components/ui/EmptyState";
import { Cols, Eyebrow, Section, Wrap } from "@/components/ui/Layout";
import { SignInPanel } from "./SignInPanel";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Member Record",
};

const LOCKED = "Sign in to view";

export default function AccountPage() {
  return (
    <>
      <Masthead name="Member Record" sub="Signed out" />

      <Section tone="clear">
        <Wrap>
          <Cols>
            <SignInPanel />

            <div>
              <Eyebrow left="Record preview" right="Form DI-07" />

              <Certificate
                className={styles.cert}
                serial="____"
                rows={[
                  { term: "Holder", value: LOCKED },
                  { term: "Class", value: LOCKED },
                  { term: "Issued", value: LOCKED },
                  { term: "Votes cast", value: LOCKED },
                ]}
              />

              <EmptyState title="No orders yet">
                Once you order, every filing you were part of shows up here with
                its certificate number.
              </EmptyState>
            </div>
          </Cols>
        </Wrap>
      </Section>

      <Footer note="Member portal" form="Form DI-07 / rev. 2026" />
    </>
  );
}
