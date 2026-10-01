import { cookies } from "next/headers";
import { getSession } from "@/lib/auth/guards";
import {
  fromThisSite,
  RECENT_SIGN_IN_S,
  SESSION_COOKIE,
  SESSION_LIFETIME_MS,
} from "@/lib/auth/session";
import { adminAuth } from "@/lib/firebase/admin";

/**
 * The server half of signing in and out.
 *
 * The browser signs in with the Firebase JS SDK (src/lib/auth/client.ts), then
 * POSTs the ID token here; this turns it into the httpOnly session cookie the
 * server reads in getSession(). DELETE ends the session: it revokes the
 * account's refresh tokens — signing it out everywhere, and making every
 * session cookie issued before now fail verifySessionCookie(cookie, true) —
 * and clears the cookie. GET says whether this request carries a valid session,
 * for the browser to check that its SDK sign-in agrees.
 */

const noStore = { "cache-control": "no-store" };

function refuse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: noStore });
}

export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refuse(403, "Cross-site request refused.");

  const body: unknown = await request.json().catch(() => null);
  const idToken =
    typeof body === "object" && body !== null && "idToken" in body
      ? (body as { idToken: unknown }).idToken
      : null;
  if (typeof idToken !== "string" || !idToken) {
    return refuse(400, "Expected an ID token.");
  }

  let authTime: number;
  try {
    // checkRevoked: a token from before a sign-out or a role change is no
    // good, even inside its hour.
    ({ auth_time: authTime } = await adminAuth().verifyIdToken(idToken, true));
  } catch {
    return refuse(401, "Sign in again.");
  }
  if (Date.now() / 1000 - authTime > RECENT_SIGN_IN_S) {
    return refuse(401, "Sign in again.");
  }

  const cookie = await adminAuth().createSessionCookie(idToken, {
    expiresIn: SESSION_LIFETIME_MS,
  });

  (await cookies()).set(SESSION_COOKIE, cookie, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_LIFETIME_MS / 1000,
  });
  return new Response(null, { status: 204, headers: noStore });
}

export async function DELETE(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refuse(403, "Cross-site request refused.");

  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value;
  if (cookie) {
    try {
      const { sub } = await adminAuth().verifySessionCookie(cookie);
      await adminAuth().revokeRefreshTokens(sub);
    } catch {
      // Already expired or revoked: nothing left to end but the cookie itself.
    }
  }
  store.delete(SESSION_COOKIE);
  return new Response(null, { status: 204, headers: noStore });
}

export async function GET(): Promise<Response> {
  const session = await getSession();
  return Response.json({ uid: session?.id ?? null }, { headers: noStore });
}
