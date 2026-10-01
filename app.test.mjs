// Proves the Next app end to end against the real emulators:
//
//   npm run test:app
//
// which runs this under `firebase emulators:exec` (Functions, Firestore, Auth,
// Storage) against the demo-degen-inc project id. It builds the app with
// `next build`, starts it with `next start`, and drives it over HTTP the way a
// browser would: signing in with the Firebase JS SDK, carrying the session
// cookie the app sets, following none of its redirects. What the app wrote is
// read back with the Admin SDK. Nothing is mocked. Set APP_TEST_SKIP_BUILD=1 to
// reuse the last build.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import { initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  updateProfile,
} from "firebase/auth";

const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-degen-inc";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PORT = 3105;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "password-123";
const NEXT = "node_modules/next/dist/bin/next";
const run = promisify(execFile);

// Start from nothing, so this suite gives the same answers whether or not
// another one ran against the same emulators first.
await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });

initAdmin();
const admin = { auth: getAdminAuth(), db: getAdminFirestore() };

// ---------------- build and start the app ----------------

// The browser config is inlined at build time, so it goes to `next build`; the
// server half (FIREBASE_CONFIG, the *_EMULATOR_HOST variables) is already in
// this environment, set by emulators:exec, and `next start` inherits it.
const appEnv = {
  ...process.env,
  NEXT_PUBLIC_FIREBASE_EMULATORS: "true",
  NEXT_PUBLIC_FIREBASE_CONFIG: JSON.stringify({
    apiKey: "demo-key",
    authDomain: `${PROJECT}.firebaseapp.com`,
    projectId: PROJECT,
    storageBucket: `${PROJECT}.appspot.com`,
  }),
};

if (process.env.APP_TEST_SKIP_BUILD !== "1") {
  const started = Date.now();
  try {
    await run(process.execPath, [NEXT, "build"], { env: appEnv, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.log(e.stdout, e.stderr);
    throw new Error("next build failed");
  }
  console.log(`     built in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

const server = spawn(process.execPath, [NEXT, "start", "-p", String(PORT)], { env: appEnv });
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
process.on("exit", () => server.kill());

async function waitFor(label, probe, ms = 60000) {
  const start = Date.now();
  let lastError = null;
  for (;;) {
    const value = await probe().catch((e) => { lastError = e; return null; });
    if (value) return value;
    if (Date.now() - start > ms) {
      throw new Error(`timed out waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
await waitFor("the app to start", async () => (await fetch(`${BASE}/api/session`)).ok);

// ---------------- helpers ----------------

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log("PASS", label); pass++; }
  catch (e) { console.log("FAIL", label, "-", e.message); fail++; }
}
function assert(cond, message) { if (!cond) throw new Error(message); }

/** A separate client SDK app per account, so several can be signed in at once. */
let apps = 0;
function browser() {
  const app = initializeApp({ projectId: PROJECT, apiKey: "demo-key" }, `browser-${apps++}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${AUTH_HOST}`, { disableWarnings: true });
  return { auth };
}

/** What the browser's sign-in does: hand the SDK's fresh ID token to /api/session. */
async function startSession(user, headers = {}) {
  const idToken = await user.getIdToken(true);
  return fetch(`${BASE}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ idToken }),
  });
}

/** The __session cookie a response set, as a Cookie header value, plus its attributes. */
function sessionCookie(res) {
  const set = res.headers.getSetCookie().find((c) => c.startsWith("__session="));
  if (!set) return null;
  return { header: set.split(";")[0], attributes: set.toLowerCase() };
}

/** Sign up exactly as SignInPanel does, and come back holding the session. */
async function enrol(email, name) {
  const b = browser();
  const { user } = await createUserWithEmailAndPassword(b.auth, email, PASSWORD);
  await updateProfile(user, { displayName: name });
  const res = await startSession(user);
  return { ...b, user, uid: user.uid, email, res, cookie: sessionCookie(res)?.header };
}

/** Sign in again, as an account must after scripts/promote-role.mjs. */
async function signInAgain(account) {
  ({ user: account.user } = await signInWithEmailAndPassword(account.auth, account.email, PASSWORD));
  const res = await startSession(account.user);
  account.cookie = sessionCookie(res)?.header;
  return res;
}

const get = (path, cookie) =>
  fetch(`${BASE}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
const whoAmI = async (cookie) => (await (await get("/api/session", cookie)).json()).uid;
/**
 * Changes a role through the real script, which also revokes the account's
 * tokens. Firebase records both a revocation and a sign-in to the second, and
 * counts a token revoked only if its sign-in is strictly earlier — so a sign-in
 * in the same second as the revocation survives it. Waiting into the next
 * second first keeps that from deciding the test.
 */
async function setRole(account, role) {
  await new Promise((r) => setTimeout(r, 1100));
  await run(process.execPath, ["scripts/promote-role.mjs", account.email, role], { env: process.env });
}

// ---------------- Step 1: sign-up, sign-in, the session cookie ----------------

let member;

await check("signing up creates the account, a users doc with role 'member', and the session cookie", async () => {
  member = await enrol("member@example.com", "Night Member");
  assert(member.res.status === 204, `POST /api/session answered ${member.res.status}`);
  const user = await waitFor("the users doc", async () => (await admin.db.doc(`users/${member.uid}`).get()).data());
  assert(user.role === "member", `users doc role is ${user.role}`);
  const claims = await waitFor("the role claim", async () => (await admin.auth.getUser(member.uid)).customClaims);
  assert(claims.role === "member", `claim is ${JSON.stringify(claims)}`);
});

await check("the session cookie is httpOnly, secure, sameSite=lax, site-wide, five days", async () => {
  const { attributes } = sessionCookie(member.res);
  for (const flag of ["httponly", "secure", "samesite=lax", "path=/", "max-age=432000"]) {
    assert(attributes.includes(flag), `missing ${flag}: ${attributes}`);
  }
});

await check("the server reads that cookie as the account, and no cookie as nobody", async () => {
  assert((await whoAmI(member.cookie)) === member.uid, "the cookie did not resolve to the account");
  assert((await whoAmI(null)) === null, "no cookie still resolved to someone");
});

await check("a cross-site sign-in is refused and sets no cookie", async () => {
  const fromElsewhere = await startSession(member.user, { origin: "https://evil.example" });
  assert(fromElsewhere.status === 403 && !sessionCookie(fromElsewhere), `Origin: answered ${fromElsewhere.status}`);
  const crossSite = await startSession(member.user, { "sec-fetch-site": "cross-site" });
  assert(crossSite.status === 403 && !sessionCookie(crossSite), `Sec-Fetch-Site: answered ${crossSite.status}`);
});

await check("an ID token that does not verify is refused", async () => {
  const res = await fetch(`${BASE}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken: "not-a-token" }),
  });
  assert(res.status === 401 && !sessionCookie(res), `answered ${res.status}`);
});

// ---------------- Step 1: /admin, decided on the server ----------------

await check("/admin redirects a signed-out visitor to /account", async () => {
  const res = await get("/admin");
  assert(res.status === 307 && new URL(res.headers.get("location"), BASE).pathname === "/account",
    `answered ${res.status} → ${res.headers.get("location")}`);
});

await check("/admin redirects a signed-in member to the storefront", async () => {
  const res = await get("/admin", member.cookie);
  assert(res.status === 307 && new URL(res.headers.get("location"), BASE).pathname === "/",
    `answered ${res.status} → ${res.headers.get("location")}`);
});

let staff;

await check("a promotion ends the old session at once; signing in again carries the staff role past /admin's guard", async () => {
  staff = await enrol("staff@example.com", "Back Office");
  await waitFor("the users doc", async () => (await admin.db.doc(`users/${staff.uid}`).get()).exists);
  const memberCookie = staff.cookie;
  await setRole(staff, "staff");
  assert((await whoAmI(memberCookie)) === null, "the pre-promotion cookie still verifies");
  const res = await signInAgain(staff);
  assert(res.status === 204, `signing in again answered ${res.status}`);
  const console_ = await get("/admin", staff.cookie);
  assert(console_.status < 300 || console_.status >= 400,
    `staff were redirected: ${console_.status} → ${console_.headers.get("location")}`);
});

// ---------------- Step 1: sign-out ----------------

await check("signing out clears the cookie, ends that session at once, and revokes the SDK's tokens", async () => {
  const before = member.cookie;
  const res = await fetch(`${BASE}/api/session`, { method: "DELETE", headers: { cookie: before } });
  assert(res.status === 204, `DELETE /api/session answered ${res.status}`);
  const cleared = sessionCookie(res);
  assert(cleared && (cleared.attributes.includes("max-age=0") || cleared.attributes.includes("expires=thu, 01 jan 1970")),
    `the cookie was not cleared: ${cleared?.attributes}`);
  assert((await whoAmI(before)) === null, "the old cookie still verifies after sign-out");
  // In production the revoked refresh token cannot be refreshed at all; the
  // Auth emulator still allows it. Either way, what the SDK holds cannot start
  // a new session: its sign-in is from before the revocation.
  const idToken = await member.user.getIdToken(true).catch(() => null);
  if (idToken) {
    const again = await fetch(`${BASE}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    assert(again.status === 401 && !sessionCookie(again), `a post-sign-out token started a session: ${again.status}`);
  }
});

// ---------------- done ----------------

if (fail > 0) console.log("\n--- app server log ---\n" + serverLog.slice(-4000));
console.log(`\n${pass} passed, ${fail} failed`);
server.kill();
process.exit(fail > 0 ? 1 : 0);
