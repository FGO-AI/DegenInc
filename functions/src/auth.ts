import * as functionsV1 from "firebase-functions/v1";
import { auth, db, FieldValue } from "./firebase";

/**
 * 1st-gen, deliberately — 2nd-gen Cloud Functions has no after-creation Auth
 * trigger, only synchronous *blocking* functions (beforeUserCreated), which
 * would remove the very race firestore.rules already documents and tests
 * for: "'Member' means any signed-in account ... including one whose role
 * claim a Cloud Function has not set yet." 1st-gen and 2nd-gen functions
 * deploy from the same codebase without conflict.
 *
 * Sets the default role claim (mirroring D1's `role` column default,
 * schema.ts:64-66) and mirrors a users/{uid} doc. No retry policy: if the
 * claim-set fails, the user simply has no elevated role, which every guard
 * already treats as "not staff/owner" — fail-safe, not fail-open. Same
 * spirit as uploadProductImage's best-effort cleanup elsewhere in this
 * codebase: a known, narrow gap, not extra machinery to close it.
 *
 * Never downgrades. This trigger runs some time after the account exists,
 * and setCustomUserClaims() replaces every claim at once — so an account
 * promoted in that gap (scripts/promote-role.mjs, or a seed script that
 * creates an owner and promotes it straight away) would otherwise be reset
 * to member. It reads the user fresh, not from the record it was handed,
 * which is a snapshot from the moment of creation, and sets member only when
 * no role is there. A promotion landing between that read and the write can
 * still be lost; the window is milliseconds, not the seconds the trigger
 * takes to fire.
 */
export const onUserCreate = functionsV1.auth.user().onCreate(async (user) => {
  const current = await auth.getUser(user.uid);
  const existing = current.customClaims?.role;
  if (existing === undefined) {
    await auth.setCustomUserClaims(user.uid, { ...current.customClaims, role: "member" });
  }
  const role = existing === "staff" || existing === "owner" ? existing : "member";

  try {
    // create(), not set(): if a client's own users/{uid} allow-create write
    // (firestore.rules) landed first, it can only have written role:'member',
    // which is what this would write for anyone not already promoted — so
    // backing off on ALREADY_EXISTS is not a bug. A promoted account's doc is
    // brought in line by scripts/promote-role.mjs, which merges the role in.
    await db.collection("users").doc(user.uid).create({
      email: user.email ?? null,
      name: user.displayName ?? "",
      role,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 6 /* ALREADY_EXISTS */) throw err;
  }
});
