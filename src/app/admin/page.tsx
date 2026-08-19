import type { Metadata } from "next";
import { requireStaff } from "@/lib/auth/guards";
import { AdminConsole } from "./AdminConsole";

export const metadata: Metadata = {
  title: "Back of House",
  // Nothing here should ever turn up in a search result.
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  // The layout already guarded this route; calling again is cheap (the session
  // lookup is request-cached) and gives us the user to render.
  const user = await requireStaff();

  return <AdminConsole userName={user.name || user.email} role={user.role} />;
}
