import type { ReactNode } from "react";
import { requireStaff } from "@/lib/auth/guards";

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
 */
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireStaff();
  return <>{children}</>;
}
