import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import type { ActionResult } from "./types";

/** A failure worth showing staff verbatim. Anything else is a bug and throws. */
export class Rejected extends Error {}

/**
 * Mirrors src/lib/auth/guards.ts's requireStaff()/requireOwner(), adapted for
 * a callable instead of a page render. D1's version redirect()s to a page;
 * there is no page here, so the equivalent "you should not have reached this"
 * signal is a thrown HttpsError, which reaches the client's httpsCallable()
 * as a rejected promise carrying a .code — the client-side wrapper (future
 * work, not this pass) can treat that the same way Filings.tsx's useSubmit()
 * already treats a thrown Server Action error: a generic message, no retry.
 *
 * Business-rule failures (bad slug, duplicate sku, wrong filing status) are
 * NOT guard failures — those throw Rejected, caught by attempt() below into
 * an ActionResult, exactly like admin.ts's explain()/Rejected.
 */
export function requireStaff(request: CallableRequest): string {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const role = request.auth.token.role;
  if (role !== "staff" && role !== "owner") {
    throw new HttpsError("permission-denied", "Staff only.");
  }
  return request.auth.uid;
}

export function requireOwner(request: CallableRequest): string {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  if (request.auth.token.role !== "owner") {
    throw new HttpsError("permission-denied", "Owner only.");
  }
  return request.auth.uid;
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
