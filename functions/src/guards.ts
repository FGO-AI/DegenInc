import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { auth } from "./firebase";
import type { ActionResult } from "./types";

/** A failure worth showing staff verbatim. Anything else is a bug and throws. */
export class Rejected extends Error {}

/**
 * The caller's role, from a token that is valid AND not revoked.
 *
 * A callable checks the ID token's signature and expiry before this runs, but
 * not whether it was revoked — so on that check alone a staff member demoted
 * by scripts/promote-role.mjs, or an account signed out through /api/session,
 * keeps working for up to an hour on the token it already holds. Verifying it
 * again with checkRevoked closes that: both revoke the account's tokens, and
 * from then on this refuses them. One extra lookup per call, on functions that
 * are called a handful of times a day.
 */
async function verifiedRole(request: CallableRequest): Promise<{ uid: string; role: unknown }> {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const header = request.rawRequest.headers.authorization ?? "";
  const idToken = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  try {
    const token = await auth.verifyIdToken(idToken, true);
    return { uid: token.uid, role: token.role };
  } catch {
    throw new HttpsError("unauthenticated", "Sign in again.");
  }
}

/**
 * Mirrors src/lib/auth/guards.ts's requireStaff()/requireOwner(), adapted for
 * a callable instead of a page render. There is no page to redirect to, so the
 * "you should not have reached this" signal is a thrown HttpsError, which
 * reaches the browser's httpsCallable() as a rejected promise carrying a .code.
 * The role is the same custom claim firestore.rules' role() reads.
 *
 * Business-rule failures (bad slug, duplicate sku, wrong filing status) are
 * NOT guard failures — those throw Rejected, caught by attempt() below into
 * an ActionResult, exactly like admin.ts's explain()/Rejected.
 */
export async function requireStaff(request: CallableRequest): Promise<string> {
  const { uid, role } = await verifiedRole(request);
  if (role !== "staff" && role !== "owner") {
    throw new HttpsError("permission-denied", "Staff only.");
  }
  return uid;
}

export async function requireOwner(request: CallableRequest): Promise<string> {
  const { uid, role } = await verifiedRole(request);
  if (role !== "owner") throw new HttpsError("permission-denied", "Owner only.");
  return uid;
}

export async function attempt<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    if (err instanceof Rejected) return { ok: false, error: err.message };
    // Any other throw becomes onCall's automatic HttpsError('internal', ...),
    // which strips the message the same way a thrown Server Action error
    // reaches the browser today — no extra code needed for parity.
    throw err;
  }
}
