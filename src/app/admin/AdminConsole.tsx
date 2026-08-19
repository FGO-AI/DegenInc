"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Footer } from "@/components/chrome/Footer";
import { Masthead } from "@/components/chrome/Masthead";
import { BackLink, Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { Section, Wrap, cx } from "@/components/ui/Layout";
import { Panel } from "@/components/ui/Panel";
import styles from "./admin.module.css";

const PANES = [
  { id: "orders", label: "Orders" },
  { id: "filings", label: "Filings" },
  { id: "members", label: "Members" },
  { id: "subs", label: "Submissions" },
] as const;

type PaneId = (typeof PANES)[number]["id"];

export function AdminConsole() {
  // NOTE: presentation state only. There is no auth here — clicking Sign in
  // reveals the console to anybody. Nothing behind it touches real data, and
  // it must not until a server-side session + staff-role check are wired up.
  // See "Wiring the backend" in the README.
  const [signedIn, setSignedIn] = useState(false);
  const [pane, setPane] = useState<PaneId>("orders");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const router = useRouter();

  function onGateSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSignedIn(true);
  }

  function signOut() {
    setSignedIn(false);
    setPane("orders");
    router.push("/");
  }

  /** Arrow keys move between tabs, as the tablist pattern expects. */
  function onTabKeyDown(e: React.KeyboardEvent, index: number) {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + PANES.length) % PANES.length;
    setPane(PANES[next].id);
    tabRefs.current[next]?.focus();
  }

  return (
    <>
      <Masthead
        name="Back of house"
        sub="Staff only"
        right={
          signedIn ? <IconButton onClick={signOut}>Sign out</IconButton> : null
        }
      />

      {!signedIn ? (
        <Section tone="clear">
          <Wrap className={styles.gate}>
            <Panel
              title="Do you work here?"
              sub="Staff accounts are made by hand. If you do not have one, you do not need one."
            >
              <form onSubmit={onGateSubmit}>
                <Field
                  id="ad-email"
                  label="Work email"
                  type="email"
                  placeholder="you@degeninc"
                  autoComplete="email"
                  required
                />
                <Field
                  id="ad-pass"
                  label="Password"
                  type="password"
                  placeholder="........"
                  autoComplete="current-password"
                  required
                />
                <Button type="submit">Sign in</Button>
              </form>
              <BackLink href="/">Never mind, take me back</BackLink>
            </Panel>
          </Wrap>
        </Section>
      ) : (
        <div className={styles.shell}>
          <aside className={styles.side}>
            <div className={styles.who}>
              <span className="mono">Signed in as</span>
              <strong>Owner</strong>
            </div>

            <div className={styles.sidenav} role="tablist" aria-label="Admin sections">
              {PANES.map((p, i) => (
                <button
                  key={p.id}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`tab-${p.id}`}
                  aria-selected={pane === p.id}
                  aria-controls={`pane-${p.id}`}
                  // Roving tabindex: only the active tab is in the tab order.
                  tabIndex={pane === p.id ? 0 : -1}
                  onClick={() => setPane(p.id)}
                  onKeyDown={(e) => onTabKeyDown(e, i)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </aside>

          <main className={styles.work}>
            <Pane id="orders" active={pane}>
              <h2>Orders</h2>
              <p className={styles.note}>
                Everything that has been paid for, in the order it came in.
                Fulfillment status syncs from the printer.
              </p>
              <div className={styles.toolrow}>
                <Button variant="ghost" compact>
                  All
                </Button>
                <Button variant="ghost" compact>
                  Unfulfilled
                </Button>
                <Button variant="ghost" compact>
                  Export
                </Button>
              </div>
              <DataTable
                columns={["Order", "Placed", "Member", "Items", "Status", "Total"]}
                empty="No orders to show"
              />
            </Pane>

            <Pane id="filings" active={pane}>
              <h2>Filings</h2>
              <p className={styles.note}>
                Each filing is one drop. Set the products, the run size, and when
                members get early access.
              </p>
              <div className={styles.toolrow}>
                <Button compact>New filing</Button>
              </div>
              <EmptyState title="No filings yet">
                Create a filing, add products to it, then schedule it. Nothing
                goes live until you publish it.
              </EmptyState>
            </Pane>

            <Pane id="members" active={pane}>
              <h2>Members</h2>
              <p className={styles.note}>
                Certificate numbers are assigned in order and cannot be reused.
              </p>
              <DataTable
                columns={["Cert no.", "Member", "Class", "Joined", "Orders", "Votes"]}
                empty="No members enrolled"
              />
            </Pane>

            <Pane id="subs" active={pane}>
              <h2>Submissions</h2>
              <p className={styles.note}>
                Artist submissions from the open call. Approve one and it becomes
                a product draft.
              </p>
              <EmptyState title="Nothing in the queue">
                Submissions from the open call form land here. You can approve,
                hold, or pass on each one.
              </EmptyState>
            </Pane>
          </main>
        </div>
      )}

      <Footer note="Back of house / restricted" form="Form DI-99 / rev. 2026" />
    </>
  );
}

function Pane({
  id,
  active,
  children,
}: {
  id: PaneId;
  active: PaneId;
  children: React.ReactNode;
}) {
  const selected = id === active;
  return (
    <div
      role="tabpanel"
      id={`pane-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={!selected}
      tabIndex={selected ? 0 : -1}
    >
      {children}
    </div>
  );
}

/** Header row plus a single full-width empty message. Rows arrive with a backend. */
function DataTable({ columns, empty }: { columns: string[]; empty: string }) {
  return (
    <div className={cx(styles.tablewrap, "rough")}>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={columns.length}>{empty}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
