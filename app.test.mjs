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
import { readFileSync } from "node:fs";
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
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

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
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  /** A catalogue function, called as the admin console calls it; returns its data or throws. */
  const call = async (name, data) => {
    const result = (await httpsCallable(functions, name)(data)).data;
    if (!result.ok) throw new Error(`${name} refused: ${result.error}`);
    return result.data;
  };
  return { auth, call };
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
  // No role claim: no claim is what makes an account a member.
  const claims = (await admin.auth.getUser(member.uid)).customClaims;
  assert(claims?.role === undefined, `a role claim was set: ${JSON.stringify(claims)}`);
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

// ---------------- Step 2: the storefront, read from Firestore ----------------

// The catalogue is made the way the console makes it: through the functions.
const owner = await enrol("owner@example.com", "Owner");
await waitFor("the owner's users doc", async () => (await admin.db.doc(`users/${owner.uid}`).get()).exists);
await setRole(owner, "owner");
await signInAgain(owner);
await signInAgain(member);

const HOUR = 60 * 60 * 1000;
// W is live and in its members' window: members since an hour ago, everyone
// in an hour. D is a draft.
const filingW = await staff.call("createFiling", {
  number: 10, title: "Window",
  memberAccessAt: new Date(Date.now() - HOUR).toISOString(),
  publicAt: new Date(Date.now() + HOUR).toISOString(),
});
const windowTee = await staff.call("createProduct", { filingId: filingW.id, slug: "window-tee", name: "Window Tee", kind: "tee", priceCents: 3400 });
const windowM = await staff.call("createVariant", { productId: windowTee.id, size: "M", color: "Black", sku: "W-M-BLK", stock: 5 });
await owner.call("updateFilingStatus", { filingId: filingW.id, status: "scheduled" });
await owner.call("updateFilingStatus", { filingId: filingW.id, status: "live" });

const filingD = await staff.call("createFiling", {
  number: 11, title: "Draft",
  memberAccessAt: new Date(Date.now() - HOUR).toISOString(),
  publicAt: new Date(Date.now() - HOUR / 2).toISOString(),
});
const draftTee = await staff.call("createProduct", { filingId: filingD.id, slug: "draft-tee", name: "Draft Tee", kind: "tee", priceCents: 2000 });
const draftM = await staff.call("createVariant", { productId: draftTee.id, size: "M", color: "Black", sku: "D-M-BLK", stock: 3 });

const html = async (path, cookie) => {
  const res = await get(path, cookie);
  return { status: res.status, body: await res.text() };
};
const cart = async (ids, cookie) =>
  (await (await get(`/api/cart?${new URLSearchParams(ids.map((id) => ["v", id]))}`, cookie)).json()).lines;

await check("/admin loads for staff, with the catalogue read from Firestore", async () => {
  const page = await html("/admin", staff.cookie);
  assert(page.status === 200, `answered ${page.status}`);
  assert(page.body.includes("Window Tee") && page.body.includes("Draft Tee"), "the catalogue is not on the page");
});

await check("/account loads for a member, from Firestore", async () => {
  const page = await html("/account", member.cookie);
  assert(page.status === 200, `answered ${page.status}`);
  assert(page.body.includes("Night Member"), "the member's name is not on the record");
});

await check("the homepage shows a filing in its members' window to a member, and not to anon", async () => {
  const asMember = await html("/", member.cookie);
  assert(asMember.status === 200 && asMember.body.includes("Window Tee"), "a member does not see the filing");
  const asAnon = await html("/");
  assert(asAnon.status === 200 && !asAnon.body.includes("Window Tee"), "anon sees a filing still in its members' window");
});

await check("a product in its members' window: anon gets a 404, a member gets the page", async () => {
  const asAnon = await html("/product/window-tee");
  assert(asAnon.status === 404, `anon got ${asAnon.status}`);
  assert(!asAnon.body.includes("Window Tee"), "the 404 still names the product");
  const asMember = await html("/product/window-tee", member.cookie);
  assert(asMember.status === 200 && asMember.body.includes("Window Tee"), `a member got ${asMember.status}`);
});

await check("a draft product's page is a 404, staff included", async () => {
  const asStaff = await html("/product/draft-tee", staff.cookie);
  assert(asStaff.status === 404, `staff got ${asStaff.status}`);
});

await check("the bag, in the members' window: a bare line for anon, the full line for a member", async () => {
  const [anonLine] = await cart([windowM.id]);
  assert(JSON.stringify(anonLine) === JSON.stringify({ variantId: windowM.id, available: false }), `anon got ${JSON.stringify(anonLine)}`);
  const [memberLine] = await cart([windowM.id], member.cookie);
  assert(memberLine.available === true && memberLine.productName === "Window Tee" && memberLine.stock === 5,
    `a member got ${JSON.stringify(memberLine)}`);
});

await check("the bag: a draft variant and an unknown id are bare lines, for a member too", async () => {
  const lines = await cart([draftM.id, "no-such-variant"], member.cookie);
  assert(JSON.stringify(lines) === JSON.stringify([
    { variantId: draftM.id, available: false },
    { variantId: "no-such-variant", available: false },
  ]), JSON.stringify(lines));
});

await check("once closed, a filing's line stays in the bag in full, unavailable, for anyone — but has no page", async () => {
  await owner.call("updateFilingStatus", { filingId: filingW.id, status: "closed" });
  const [anonLine] = await cart([windowM.id]);
  assert(anonLine.available === false && anonLine.productName === "Window Tee", `anon got ${JSON.stringify(anonLine)}`);
  const page = await html("/product/window-tee", member.cookie);
  assert(page.status === 404, `a closed product's page answered ${page.status}`);
});

// ---------------- Step 3: images, from Cloud Storage, to who may see them ----------------

// A real JPEG header (SOI + APP0/JFIF) padded to the 12 bytes the sniffer needs.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]);
const upload = (productId) => staff.call("uploadProductImage", { productId, fileBase64: JPEG.toString("base64") });

// X is live and in its members' window, like W was.
const filingX = await staff.call("createFiling", {
  number: 12, title: "Window again",
  memberAccessAt: new Date(Date.now() - HOUR).toISOString(),
  publicAt: new Date(Date.now() + HOUR).toISOString(),
});
const xTee = await staff.call("createProduct", { filingId: filingX.id, slug: "x-tee", name: "X Tee", kind: "tee", priceCents: 3400 });
await owner.call("updateFilingStatus", { filingId: filingX.id, status: "scheduled" });
await owner.call("updateFilingStatus", { filingId: filingX.id, status: "live" });

const imageX = await upload(xTee.id);         // members' window
const imageD = await upload(draftTee.id);     // draft
const imageW = await upload(windowTee.id);    // closed

const image = async (path, cookie) => {
  const res = await get(`/images/${path}`, cookie);
  return { status: res.status, cache: res.headers.get("cache-control"), type: res.headers.get("content-type"), bytes: Buffer.from(await res.arrayBuffer()) };
};

await check("a members'-window image: refused for anon, served to a member, privately", async () => {
  const asAnon = await image(imageX.path);
  assert(asAnon.status === 404, `anon got ${asAnon.status}`);
  const asMember = await image(imageX.path, member.cookie);
  assert(asMember.status === 200 && asMember.type === "image/jpeg", `a member got ${asMember.status} ${asMember.type}`);
  assert(asMember.bytes.equals(JPEG), "the bytes served are not the bytes uploaded");
  assert(asMember.cache === "private, no-store", `cached as ${asMember.cache}`);
});

await check("a draft's image: refused for a member, served to staff, privately", async () => {
  const asMember = await image(imageD.path, member.cookie);
  assert(asMember.status === 404, `a member got ${asMember.status}`);
  const asStaff = await image(imageD.path, staff.cookie);
  assert(asStaff.status === 200 && asStaff.cache === "private, no-store", `staff got ${asStaff.status}, cached as ${asStaff.cache}`);
});

await check("a closed product's image: served to anyone, and cached publicly", async () => {
  const asAnon = await image(imageW.path);
  assert(asAnon.status === 200 && asAnon.bytes.equals(JPEG), `anon got ${asAnon.status}`);
  assert(asAnon.cache === "public, max-age=31536000, immutable", `cached as ${asAnon.cache}`);
});

await check("a key the product does not list, or of the wrong shape, is a 404 for anyone", async () => {
  const unlisted = `products/${xTee.id}/00000000-0000-4000-8000-000000000000.jpg`;
  for (const path of [unlisted, "elsewhere/thing.jpg", `products/${xTee.id}/..%2F..%2Fsecret`, `products/${xTee.id}`]) {
    const res = await image(path, staff.cookie);
    assert(res.status === 404, `${path} answered ${res.status}`);
  }
});

// ---------------- Step 5: checkout, as one Firestore transaction ----------------

// The bag page's own Server Action, called the way the page calls it: a POST
// to /cart naming the action. It is the only action in the app, so the build's
// manifest has exactly one entry, under app/cart/page.
const actions = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const purchaseCartId = Object.keys(actions).find((id) => Object.keys(actions[id].workers ?? {}).includes("app/cart/page"));
async function purchaseCart(cookie, items) {
  const res = await fetch(`${BASE}/cart`, {
    method: "POST",
    headers: { "next-action": purchaseCartId, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component", cookie },
    body: JSON.stringify([items]),
  });
  const body = await res.text();
  const result = body.match(/\{"ok":(?:true|false)[^}]*\}/);
  if (!result) throw new Error(`no result from the action: ${res.status} ${body.slice(0, 200)}`);
  return JSON.parse(result[0]);
}
const checkout = (cookie, variantId, quantity = 1) =>
  fetch(`${BASE}/api/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ variantId, quantity }),
  });
const stockOf = async (variantId) => (await admin.db.doc(`variants/${variantId}`).get()).get("stock");
const ordersOf = async (memberId) => (await admin.db.collection("orders").where("memberId", "==", memberId).get()).docs;

// X is still live and in its members' window. Two variants: the last one of
// M, for the race, and ten of L.
const xLast = await staff.call("createVariant", { productId: xTee.id, size: "M", color: "Black", sku: "X-M-BLK", stock: 1 });
const xMany = await staff.call("createVariant", { productId: xTee.id, size: "L", color: "Black", sku: "X-L-BLK", stock: 10 });
const rival = await enrol("rival@example.com", "Rival");
await waitFor("the rival's users doc", async () => (await admin.db.doc(`users/${rival.uid}`).get()).exists);

await check("a member checks out through the bag's own action: one order, its lines inside it, stock taken off", async () => {
  const result = await purchaseCart(member.cookie, [{ variantId: xMany.id, quantity: 2 }]);
  assert(result.ok === true && result.orderId, JSON.stringify(result));
  const order = (await admin.db.doc(`orders/${result.orderId}`).get()).data();
  assert(order.memberId === member.uid && order.status === "pending" && order.totalCents === 6800, JSON.stringify(order));
  const [line] = order.items;
  assert(order.items.length === 1 && line.variantId === xMany.id && line.quantity === 2 && line.unitPriceCents === 3400,
    JSON.stringify(order.items));
  assert(line.nameSnapshot === "X Tee" && line.variantSnapshot === "L / Black", JSON.stringify(line));
  assert((await stockOf(xMany.id)) === 8, `stock is ${await stockOf(xMany.id)}`);
  const record = await html("/account", member.cookie);
  assert(record.body.includes("$68"), "the order is not on the member's record");
});

await check("two checkouts of the last one at the same instant: one order, one clean refusal, stock 0 not -1", async () => {
  // Both requests go to one server at once, so their transactions run side by
  // side; the timings in the log say whether they actually contended.
  const started = Date.now();
  const timed = (p) => p.then((r) => ({ r, ms: Date.now() - started }));
  const raced = await Promise.all([timed(checkout(member.cookie, xLast.id)), timed(checkout(rival.cookie, xLast.id))]);
  const responses = raced.map((x) => x.r);
  const bodies = await Promise.all(responses.map((r) => r.json()));
  console.log(`     checkout race: ${raced.map((x, i) => `${x.r.status} ${bodies[i]?.error ?? "ok"} in ${x.ms}ms`).join(", ")}`);
  const statuses = responses.map((r) => r.status).sort();
  assert(statuses[0] === 200 && statuses[1] === 409, `statuses ${statuses}, bodies ${JSON.stringify(bodies)}`);
  assert(bodies.some((b) => b.error === "out_of_stock"), JSON.stringify(bodies));
  assert((await stockOf(xLast.id)) === 0, `stock is ${await stockOf(xLast.id)}`);
  const orders = (await admin.db.collection("orders").get()).docs.filter((o) => o.get("items").some((i) => i.variantId === xLast.id));
  assert(orders.length === 1, `${orders.length} orders hold the last one`);
});

await check("an order of more than 25 different items is refused, and nothing is written", async () => {
  const before = (await ordersOf(member.uid)).length;
  const lines = Array.from({ length: 26 }, (_, i) => ({ variantId: `v${i}`, quantity: 1 }));
  const result = await purchaseCart(member.cookie, lines);
  assert(result.ok === false && result.error === "An order can hold up to 25 different items.", JSON.stringify(result));
  assert((await ordersOf(member.uid)).length === before, "an order was written");
});

await check("a draft's variant is refused in the same words as one that does not exist", async () => {
  const draft = await purchaseCart(member.cookie, [{ variantId: draftM.id, quantity: 1 }]);
  const unknown = await purchaseCart(member.cookie, [{ variantId: "no-such-variant", quantity: 1 }]);
  assert(draft.ok === false && draft.error === "Something in this order is no longer sold.", JSON.stringify(draft));
  assert(unknown.ok === false && unknown.error === draft.error, JSON.stringify(unknown));
  assert((await stockOf(draftM.id)) === 3, "the draft's stock moved");
});

await check("a signed-out caller cannot check out", async () => {
  const res = await checkout(null, xMany.id);
  assert(res.status === 401, `answered ${res.status}`);
  assert((await stockOf(xMany.id)) === 8, "stock moved");
});

await check("a filing closed while its line is in the bag: shown unavailable, by name, and the order refused", async () => {
  await owner.call("updateFilingStatus", { filingId: filingX.id, status: "closed" });
  const [line] = await cart([xMany.id], member.cookie);
  assert(line.available === false && line.productName === "X Tee", JSON.stringify(line));
  const result = await purchaseCart(member.cookie, [{ variantId: xMany.id, quantity: 1 }]);
  assert(result.ok === false && result.error.startsWith("Part of this order is from a filing that has closed"), JSON.stringify(result));
  const res = await checkout(member.cookie, xMany.id);
  assert(res.status === 409 && (await res.json()).error === "filing_closed", `answered ${res.status}`);
  assert((await stockOf(xMany.id)) === 8, `stock is ${await stockOf(xMany.id)}`);
});

await check("before a member's window opens, a live filing's variant cannot be bought", async () => {
  const early = await staff.call("createFiling", {
    number: 13, title: "Not yet",
    memberAccessAt: new Date(Date.now() + HOUR).toISOString(),
    publicAt: new Date(Date.now() + 2 * HOUR).toISOString(),
  });
  const earlyTee = await staff.call("createProduct", { filingId: early.id, slug: "early-tee", name: "Early Tee", kind: "tee", priceCents: 3000 });
  const earlyM = await staff.call("createVariant", { productId: earlyTee.id, size: "M", color: "Black", sku: "E-M-BLK", stock: 5 });
  await owner.call("updateFilingStatus", { filingId: early.id, status: "scheduled" });
  await owner.call("updateFilingStatus", { filingId: early.id, status: "live" });
  const result = await purchaseCart(member.cookie, [{ variantId: earlyM.id, quantity: 1 }]);
  assert(result.ok === false && result.error === "Something in this order is no longer sold.", JSON.stringify(result));
  assert((await stockOf(earlyM.id)) === 5, "stock moved");
});

// ---------------- done ----------------

if (fail > 0) console.log("\n--- app server log ---\n" + serverLog.slice(-4000));
console.log(`\n${pass} passed, ${fail} failed`);
server.kill();
process.exit(fail > 0 ? 1 : 0);
