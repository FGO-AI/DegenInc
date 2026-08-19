import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth } from "./index";

/**
 * The authorization layer.
 *
 * This module is what replaced Row Level Security. Under Postgres the database
 * refused to return rows the caller shouldn't see; D1 will hand back anything
 * it is asked for. So authorization is application code — code you can forget
 * to write — and every non-public data function calls one of these first.
 *
 * These read the session from the request cookie and verify it against the
 * database. Never derive a role from anything the client sent.
 */

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "member" | "staff" | "owner";
};

/**
 * Current session, or null when signed out.
 *
 * Wrapped in React's `cache` so a layout and the page beneath it share one
 * lookup per request rather than hitting D1 twice.
 */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  const auth = await getAuth();
  const result = await auth.api.getSession({ headers: await headers() });

  if (!result?.user) return null;

  const role = (result.user as { role?: string }).role;

  return {
    id: result.user.id,
    email: result.user.email,
    name: result.user.name,
    role: role === "staff" || role === "owner" ? role : "member",
  };
});

/**
 * Require any signed-in user. Redirects to /account when signed out.
 *
 * Redirect rather than hide: a hidden control is still reachable by anyone who
 * knows the URL, and the decision has to be made on the server regardless.
 */
export async function requireMember(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect("/account");
  return session;
}

/**
 * Require back-of-house access.
 *
 * Signed-out users go to /account. Signed-in non-staff go to the storefront —
 * deliberately not to a "forbidden" page, which would confirm that /admin
 * exists and is worth attacking.
 */
export async function requireStaff(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect("/account");
  if (session.role !== "staff" && session.role !== "owner") redirect("/");
  return session;
}

/** Owner-only actions, e.g. anything destructive. */
export async function requireOwner(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect("/account");
  if (session.role !== "owner") redirect("/");
  return session;
}
