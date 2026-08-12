import type { Metadata } from "next";
import { AdminConsole } from "./AdminConsole";

export const metadata: Metadata = {
  title: "Back of House",
  // Nothing here should ever turn up in a search result.
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <AdminConsole />;
}
