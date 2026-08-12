import { Certificate } from "@/components/ui/Certificate";
import { Cols, Prose, Section, Wrap } from "@/components/ui/Layout";

/** What membership actually is, next to the certificate it gets you. */
export function Collective() {
  return (
    <Section id="collective" tone="clear">
      <Wrap>
        <Cols>
          <Prose>
            <h2 className="eroded">The Collective</h2>
            <p>
              Buying something makes you a shareholder on paper. It is a joke
              and it is also real: every order ships with a numbered
              certificate, and the number is yours permanently.
            </p>
            <p>
              <strong>What it actually gets you.</strong> Early access to each
              filing, a vote on which submitted designs get printed, and your
              name on the piece if we print yours.
            </p>
            <p>
              Reps run their own scenes. If you already have people around you,
              you do not need permission from us to put them on.
            </p>
          </Prose>

          <div>
            <Certificate
              serial="0000"
              rows={[
                { term: "Holder", value: "Unissued" },
                { term: "Class", value: "Unissued" },
                { term: "Issued", value: "Pending" },
                { term: "Voting rights", value: "One per filing" },
              ]}
              note="Certificates are issued in order. Number one goes to whoever buys first, and it does not transfer."
            />
          </div>
        </Cols>
      </Wrap>
    </Section>
  );
}
