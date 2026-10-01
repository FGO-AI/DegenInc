// Give an existing account the staff or owner role (or take it away):
//
//   node scripts/promote-role.mjs <uid-or-email> <staff|owner|member>
//   node scripts/promote-role.mjs --emulator <uid-or-email> <staff|owner|member>
//
// The only way a role changes. firestore.rules never lets a client write one,
// and there is no callable for it — the admin console has no members screen,
// and a shop this size promotes someone by hand, rarely.
//
// --emulator talks to the local emulators (`npm run emulators`, the ports in
// firebase.json, project demo-degen-inc). Without it, this changes the REAL
// project, and needs Application Default Credentials — either
// `gcloud auth application-default login`, or GOOGLE_APPLICATION_CREDENTIALS
// pointing at a key file kept outside the repo — plus GOOGLE_CLOUD_PROJECT set
// to the project id. Run under `firebase emulators:exec` it talks to that
// run's emulators, which set their own hosts and project id.
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
const args = process.argv.slice(2);
const emulator = args[0] === "--emulator";
const [identifier, role] = emulator ? args.slice(1) : args;
if (!identifier || !ROLES.includes(role ?? "")) {
  console.error("Usage: node scripts/promote-role.mjs [--emulator] <uid-or-email> <staff|owner|member>");
  process.exit(1);
}

if (emulator) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
  process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
  process.env.GCLOUD_PROJECT ||= "demo-degen-inc";
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
