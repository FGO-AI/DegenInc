import type { ReactNode } from "react";
import { requireStaff } from "@/lib/auth/guards";
import { SessionSync } from "@/lib/auth/SessionSync";

/**
 * The real admin gate.
 *
 * Decided on the server, before any child renders, and it REDIRECTS rather
 * than hiding: a hidden console is still reachable by anyone who knows the
 * URL. This replaced a `useState` in AdminConsole that let anybody in by
 * clicking a button.
 *
 * Because this runs in the layout, every route under /admin inherits it —
 * including ones added later, which is the point of putting it here rather
 * than in the page.
 *
 * SessionSync is here too because the console calls Cloud Functions with the
 * browser SDK's sign-in, which has to belong to the same account as the
 * session cookie this guard just checked.
 */
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireStaff();
  return (
    <>
      <SessionSync uid={session.id} />
      {children}
    </>
  );
}
