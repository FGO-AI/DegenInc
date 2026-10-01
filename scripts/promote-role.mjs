// Give an existing account the staff or owner role:
//
//   node scripts/promote-role.mjs <uid-or-email> <staff|owner|member>
//
// The only way a role changes. firestore.rules never lets a client write one,
// and there is no callable for it — the admin console has no members screen,
// and a shop this size promotes someone by hand, rarely.
//
// Against the real project it needs Application Default Credentials, either
// GOOGLE_APPLICATION_CREDENTIALS pointing at a service account key or
// `gcloud auth application-default login`, plus GOOGLE_CLOUD_PROJECT set to
// the project id. Run under `firebase emulators:exec` it talks to the
// emulators instead, which set their own hosts and project id.
//
// It also revokes the account's tokens, which signs the person out everywhere:
// their session cookie stops verifying, and their next Cloud Function call is
// refused. That is what makes a role change take effect at once — demoting
// someone must not leave them five more days of an old cookie, or an hour of
// an old token. They sign in again, and that new sign-in carries the new role.

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const ROLES = ["member", "staff", "owner"];
const [, , identifier, role] = process.argv;
if (!identifier || !ROLES.includes(role ?? "")) {
  console.error("Usage: node scripts/promote-role.mjs <uid-or-email> <staff|owner|member>");
  process.exit(1);
}

initializeApp();
const auth = getAuth();
const db = getFirestore();

const user = identifier.includes("@")
  ? await auth.getUserByEmail(identifier)
  : await auth.getUser(identifier);

// setCustomUserClaims() replaces every claim, so carry the others over.
await auth.setCustomUserClaims(user.uid, { ...user.customClaims, role });
await auth.revokeRefreshTokens(user.uid);
// The users doc mirrors the claim for anything that lists accounts; the claim
// is what rules and functions actually check.
await db.collection("users").doc(user.uid).set({ role }, { merge: true });

console.log(`${user.email ?? user.uid} is now ${role}, and signed out everywhere. Their next sign-in carries the new role.`);
