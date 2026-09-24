import type { Metadata } from "next";
import { Footer } from "@/components/chrome/Footer";
import { Masthead } from "@/components/chrome/Masthead";
import { BackLink } from "@/components/ui/Button";
import { Certificate } from "@/components/ui/Certificate";
import { EmptyState } from "@/components/ui/EmptyState";
import { Cols, Eyebrow, Section, Wrap, cx } from "@/components/ui/Layout";
import { Panel } from "@/components/ui/Panel";
import { getSession } from "@/lib/auth/guards";
import { getMemberRecord, type MemberOrder } from "@/lib/db/queries";
import { money, stamp } from "@/lib/format";
import { SignInPanel } from "./SignInPanel";
import { SignOutButton, SignOutIconButton } from "./SignOutButton";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Member Record",
};

const LOCKED = "Sign in to view";

/**
 * The member record.
 *
 * This used to be a non-async component that rendered the signed-out shell
 * unconditionally — which meant SignInPanel's router.refresh() re-ran a server
 * component whose output did not depend on the session, so signing in changed
 * nothing on screen and read as a broken login. Reading the session here is
 * the whole fix.
 *
 * Reading it also makes the route dynamic, since getSession() calls
 * connection(). That is the necessary price: a cached signed-out shell is
 * exactly the bug.
 */
export default async function AccountPage() {
  const session = await getSession();
  if (!session) return <SignedOut />;

  const record = await getMemberRecord();

  // The masthead sub is 9px mono with wide tracking and no wrapping guard, so
  // keep it short: the email's local part rather than the whole address, which
  // is also the name SignInPanel defaults to at sign-up.
  const displayName = session.name || session.email.split("@")[0];
  const serial = record.certificate
    ? String(record.certificate.number).padStart(4, "0")
    : "____";

  return (
    <>
      <Masthead
        name="Member Record"
        sub={displayName}
        right={<SignOutIconButton />}
      />

      <Section tone="clear">
        <Wrap>
          <Cols>
            <Panel title="Your standing" sub={session.email}>
              <p className={styles.standing}>
                {record.certificate
                  ? `Certificate ${serial} / ${record.certificate.class}`
                  : "Certificate pending"}
              </p>

              <SignOutButton />
              <BackLink href="/">Back to the shop</BackLink>
            </Panel>

            <div>
              <Eyebrow left="Your record" right="Form DI-07" />

              <Certificate
                className={styles.cert}
                serial={serial}
                rows={[
                  { term: "Holder", value: displayName },
                  {
                    term: "Class",
                    value: record.certificate?.class ?? "Unissued",
                  },
                  {
                    term: "Issued",
                    value: record.certificate
                      ? stamp(record.certificate.issuedAt)
                      : "—",
                  },
                  { term: "Votes cast", value: record.votesCast },
                ]}
                note={
                  record.certificate
                    ? undefined
                    : "Your number is issued with your first order. It is assigned in sequence and it does not transfer."
                }
              />

              {record.orders.length === 0 ? (
                <EmptyState title="No orders yet">
                  Once you order, every filing you were part of shows up here
                  with its certificate number.
                </EmptyState>
              ) : (
                <>
                  <Eyebrow
                    left="Order history"
                    right={`${record.orders.length} on file`}
                  />
                  <OrderList orders={record.orders} />
                </>
              )}
            </div>
          </Cols>
        </Wrap>
      </Section>

      <Footer note="Member portal" form="Form DI-07 / rev. 2026" />
    </>
  );
}

/**
 * The signed-out shell — what this page rendered before the session read was
 * added, unchanged.
 */
function SignedOut() {
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

/**
 * Order history.
 *
 * A list rather than a table. Admin's DataTable lives in a "use client" file,
 * takes no rows, and needs min-width 560px plus a horizontal scrollbar — wrong
 * for a column that is half the measure and stacks to phone width at 900px.
 *
 * Orders have no printed number, only a UUID, so the reference is its first
 * eight characters. That is unambiguous within one member's fifty orders and
 * reads as a filing reference rather than a leaked database key.
 */
function OrderList({ orders }: { orders: MemberOrder[] }) {
  return (
    <ul className={cx(styles.orders, "rough")}>
      {orders.map((order) => (
        <li key={order.id} className={styles.order}>
          <div className={styles.orderHead}>
            <span className="mono">
              Ref {order.id.slice(0, 8).toUpperCase()} / {stamp(order.placedAt)}
            </span>
            <span className={styles.total}>{money(order.totalCents)}</span>
          </div>

          {/* One row per line item, not a comma-joined sentence: with the
              variant beside each name, two sizes of one shirt read as two
              different lines. Lines predating variant_snapshot show the
              name alone. */}
          <ul className={styles.lines}>
            {order.lines.length > 0 ? (
              order.lines.map((l, i) => (
                <li key={i}>
                  {l.name}
                  {/* A real space, not just margin, so assistive tech and
                      copied text do not read "TeeM / Black". */}
                  {l.variant && (
                    <>
                      {" "}
                      <span className={cx("mono", styles.variant)}>
                        {l.variant}
                      </span>
                    </>
                  )}
                  {l.quantity > 1 && ` x${l.quantity}`}
                </li>
              ))
            ) : (
              <li>No line items on file</li>
            )}
          </ul>

          <span className="mono">{order.status}</span>
        </li>
      ))}
    </ul>
  );
}
