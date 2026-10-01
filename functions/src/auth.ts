import * as functionsV1 from "firebase-functions/v1";
import { auth, db, FieldValue } from "./firebase";

/**
 * Writes the users/{uid} document for a new account, with role 'member'.
 *
 * 1st-gen, deliberately — 2nd-gen Cloud Functions has no after-creation Auth
 * trigger, only synchronous *blocking* functions (beforeUserCreated). 1st-gen
 * and 2nd-gen functions deploy from the same codebase without conflict.
 *
 * It sets NO role claim. An account with no role claim is a member everywhere
 * a role is checked — firestore.rules' role(), getSession() on the server, the
 * function guards — so there is nothing for it to set. That matters because
 * this trigger runs some time after the account exists, and
 * setCustomUserClaims() replaces every claim at once: an earlier version set
 * 'member' here, and an owner promoted in the gap between its read and its
 * write was silently demoted (the functions test caught it). Now only
 * scripts/promote-role.mjs ever writes a role claim, so nothing can overwrite
 * one.
 *
 * The document mirrors the role for anything that lists accounts; the claim is
 * what is checked. It is written with the role the account has right now —
 * 'member', unless a promotion already landed — and with create(), so if a
 * document is already there it backs off. Either way round, promote-role.mjs
 * merges the current role into the document after setting the claim, so the
 * two end up agreeing.
 */
export const onUserCreate = functionsV1.auth.user().onCreate(async (user) => {
  const claimed = (await auth.getUser(user.uid)).customClaims?.role;
  const role = claimed === "staff" || claimed === "owner" ? claimed : "member";

  try {
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
