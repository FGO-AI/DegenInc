import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { adminAuth } from "@/lib/firebase/admin";
import { SESSION_COOKIE } from "./session";

/**
 * The authorization layer for the server.
 *
 * The Next server reads and writes Firestore with the Admin SDK, which bypasses
 * firestore.rules entirely. The rules protect the browser and mobile apps; on
 * this path the database refuses nothing. So authorization here is application
 * code — code you can forget to write — and every non-public data function
 * calls one of these first.
 *
 * These read the session cookie and verify it with Firebase Authentication.
 * The role is the account's custom claim, set only by the Admin SDK
 * (scripts/promote-role.mjs, functions/src/auth.ts) — the same claim
 * firestore.rules' role() reads. Never derive a role from anything the client
 * sent.
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
 * verification per request.
 */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  // Stop prerendering BEFORE touching auth. connection() resolves only at
  // request time, so during a build this function stops here and the route is
  // excluded from prerendering, rather than the build trying to verify a
  // cookie that does not exist.
  await connection();

  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) return null;

  let claims;
  try {
    // true: also check revocation, so a sign-out or a role change ends this
    // session now, not when the cookie runs out.
    claims = await adminAuth().verifySessionCookie(cookie, true);
  } catch {
    return null;
  }

  // Anything other than the two elevated roles — including no claim yet,
  // between sign-up and the onUserCreate trigger — is a member.
  const role = claims.role;

  return {
    id: claims.uid,
    email: claims.email ?? "",
    name: typeof claims.name === "string" ? claims.name : "",
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
