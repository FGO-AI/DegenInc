// Proves the catalogue Cloud Functions against the real emulators:
//
//   npm run test:functions
//
// which builds functions/ and wraps `firebase emulators:exec --only
// functions,firestore,auth,storage` against the demo-degen-inc project id (no
// login, no real project). Needs JDK 21 on PATH, like test:rules.
//
// Every call goes through the client SDK as a real signed-in account would —
// sign-up, the onUserCreate trigger, promotion by scripts/promote-role.mjs, a
// token refresh — and every outcome is read back with the Admin SDK. Nothing
// is mocked.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import { getStorage as getAdminStorage } from "firebase-admin/storage";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-degen-inc";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const run = promisify(execFile);

// Admin side: reads back what the functions wrote. FIREBASE_CONFIG, set by
// emulators:exec, supplies the same default bucket the functions see.
initAdmin();
const admin = {
  auth: getAdminAuth(),
  db: getAdminFirestore(),
  bucket: getAdminStorage().bucket(),
};

/** A separate client app per account, so several can be signed in at once. */
let apps = 0;
function client() {
  const app = initializeApp({ projectId: PROJECT, apiKey: "demo-key" }, `client-${apps++}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${AUTH_HOST}`, { disableWarnings: true });
  const functions = getFunctions(app);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return {
    auth,
    call: async (name, data) => (await httpsCallable(functions, name)(data)).data,
  };
}

async function signUp(email) {
  const c = client();
  const { user } = await createUserWithEmailAndPassword(c.auth, email, "password-123");
  return { ...c, user, uid: user.uid, email };
}

async function waitFor(label, probe, ms = 20000) {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Waits for onUserCreate to finish with this account: its users doc exists. */
const settled = (uid) =>
  waitFor(`onUserCreate for ${uid}`, async () => (await admin.db.doc(`users/${uid}`).get()).exists);

/** Promotes through the real script, the way the owner would, then refreshes the token. */
async function promote(account, role) {
  await run(process.execPath, ["scripts/promote-role.mjs", account.email, role], { env: process.env });
  await account.user.getIdToken(true);
}

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log("PASS", label); pass++; }
  catch (e) { console.log("FAIL", label, "-", e.message); fail++; }
}
function assert(cond, message) { if (!cond) throw new Error(message); }

/** A callable must reject with this HttpsError code. */
async function denied(promise, code) {
  try { await promise; } catch (e) {
    assert(e.code === `functions/${code}`, `expected functions/${code}, got ${e.code}: ${e.message}`);
    return;
  }
  throw new Error(`expected functions/${code}, but the call succeeded`);
}
/** A callable must come back { ok: false } with exactly this message. */
function refused(result, error) {
  assert(result && result.ok === false, `expected { ok: false }, got ${JSON.stringify(result)}`);
  assert(result.error === error, `expected error "${error}", got "${result.error}"`);
}
function succeeded(result) {
  assert(result && result.ok === true, `expected { ok: true }, got ${JSON.stringify(result)}`);
  return result.data;
}

const HOUR = 60 * 60 * 1000;
const memberAccessAt = new Date(Date.now() + HOUR).toISOString();
const publicAt = new Date(Date.now() + 2 * HOUR).toISOString();

// A real JPEG header (SOI + APP0/JFIF) padded to the 12 bytes the sniffer needs.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

// ---------------- accounts and roles ----------------

let member, staff, owner;

await check("a fresh sign-up gets role 'member' on both its claim and its users doc", async () => {
  member = await signUp("member@example.com");
  await settled(member.uid);
  const record = await admin.auth.getUser(member.uid);
  assert(record.customClaims?.role === "member", `claim is ${JSON.stringify(record.customClaims)}`);
  const docRole = (await admin.db.doc(`users/${member.uid}`).get()).data()?.role;
  assert(docRole === "member", `users doc role is ${docRole}`);
});

await check("a signed-out caller is refused (unauthenticated)", async () => {
  await denied(client().call("createFiling", { number: 900, title: "Nope" }), "unauthenticated");
});

await check("a member is refused a staff-only function (permission-denied)", async () => {
  await member.user.getIdToken(true);
  await denied(member.call("createFiling", { number: 900, title: "Nope" }), "permission-denied");
});

await check("a promotion only takes effect once the token is refreshed", async () => {
  staff = await signUp("staff@example.com");
  await settled(staff.uid);
  await staff.user.getIdToken(); // the member token, cached
  await run(process.execPath, ["scripts/promote-role.mjs", staff.email, "staff"], { env: process.env });
  // Same cached token: still member as far as the function can tell.
  await denied(staff.call("createFiling", { number: 901, title: "Too soon" }), "permission-denied");
  await staff.user.getIdToken(true);
  const record = await admin.auth.getUser(staff.uid);
  assert(record.customClaims?.role === "staff", `claim is ${JSON.stringify(record.customClaims)}`);
  const docRole = (await admin.db.doc(`users/${staff.uid}`).get()).data()?.role;
  assert(docRole === "staff", `users doc role is ${docRole}`);
});

owner = await signUp("owner@example.com");
await settled(owner.uid);
await promote(owner, "owner");

await check("onUserCreate never downgrades a role set before it ran", async () => {
  // Created and promoted in one breath, the way a seed script would, so the
  // promotion usually lands before the trigger fires.
  const created = await admin.auth.createUser({ email: "seeded-owner@example.com", password: "password-123" });
  await admin.auth.setCustomUserClaims(created.uid, { role: "owner" });
  await settled(created.uid);
  const record = await admin.auth.getUser(created.uid);
  assert(record.customClaims?.role === "owner", `claim is ${JSON.stringify(record.customClaims)}`);
  const docRole = (await admin.db.doc(`users/${created.uid}`).get()).data()?.role;
  // "owner" here means the trigger ran after the promotion and read it, which
  // is the ordering this check exists for. "member" would mean it ran first,
  // and the check proved less than it claims — say so rather than pass quietly.
  assert(docRole === "owner", `users doc role is ${docRole}: the trigger ran before the promotion, so this ordering was not exercised`);
});

// ---------------- filings ----------------

await check("staff can create a filing, as a draft, keyed by its padded number", async () => {
  const data = succeeded(await staff.call("createFiling", { number: 1, title: "Night Shift" }));
  assert(data.id === "001" && data.status === "draft", JSON.stringify(data));
  const doc = (await admin.db.doc("filings/001").get()).data();
  assert(doc?.status === "draft" && doc?.number === 1, JSON.stringify(doc));
});

await check("a duplicate filing number is refused with admin.ts's own message", async () => {
  refused(await staff.call("createFiling", { number: 1, title: "Again" }), "Filing 001 already exists.");
});

await check("member access after the public date is refused", async () => {
  refused(
    await staff.call("createFiling", { number: 9, title: "Backwards", memberAccessAt: publicAt, publicAt: memberAccessAt }),
    "Member access cannot start after the public date.",
  );
});

succeeded(await staff.call("createFiling", { number: 2, title: "Second" }));
succeeded(await staff.call("createFiling", { number: 3, title: "Timed", memberAccessAt, publicAt }));
succeeded(await staff.call("createFiling", { number: 4, title: "Timed too", memberAccessAt, publicAt }));
succeeded(await staff.call("createFiling", { number: 5, title: "Timed three", memberAccessAt, publicAt }));

// ---------------- products ----------------

await check("staff can create a product, keyed by its slug, copying its filing's state", async () => {
  const data = succeeded(await staff.call("createProduct", {
    filingId: "001", slug: "void-hood", name: "Void Hood", kind: "hoodie", priceCents: 6500,
  }));
  assert(data.id === "void-hood", JSON.stringify(data));
  const doc = (await admin.db.doc("products/void-hood").get()).data();
  assert(doc?.filingStatus === "draft" && doc?.position === 0 && Array.isArray(doc?.images), JSON.stringify(doc));
});

await check("a duplicate slug is refused, even under a different filing", async () => {
  refused(
    await staff.call("createProduct", { filingId: "002", slug: "void-hood", name: "Other", kind: "tee", priceCents: 100 }),
    'The slug "void-hood" is already taken.',
  );
});

await check("a product under a filing that does not exist is refused", async () => {
  refused(
    await staff.call("createProduct", { filingId: "404", slug: "orphan-tee", name: "Orphan", kind: "tee", priceCents: 100 }),
    "That filing no longer exists.",
  );
});

succeeded(await staff.call("createProduct", { filingId: "002", slug: "other-tee", name: "Other Tee", kind: "tee", priceCents: 3000 }));

// ---------------- variants ----------------

await check("staff can create a variant, keyed by size_color", async () => {
  const data = succeeded(await staff.call("createVariant", { productId: "void-hood", size: "M", color: "Black", sku: "DGN-001-M-BLK", stock: 10 }));
  assert(data.id === "M_Black", JSON.stringify(data));
  const sku = (await admin.db.doc("skus/DGN-001-M-BLK").get()).data();
  assert(sku?.productId === "void-hood" && sku?.variantId === "M_Black", JSON.stringify(sku));
});

await check("a second variant with the same size and color on one product is refused", async () => {
  refused(
    await staff.call("createVariant", { productId: "void-hood", size: "M", color: "Black", sku: "DGN-001-M-BLK-2", stock: 1 }),
    "This product already has a M / Black variant.",
  );
});

await check("a duplicate SKU is refused across products, and nothing is half-written", async () => {
  refused(
    await staff.call("createVariant", { productId: "other-tee", size: "L", color: "White", sku: "DGN-001-M-BLK", stock: 1 }),
    "SKU DGN-001-M-BLK is already in use.",
  );
  const stray = await admin.db.doc("products/other-tee/variants/L_White").get();
  assert(!stray.exists, "the refused variant was written anyway");
});

await check("a SKU Firestore reserves as a document id (__x__) is refused cleanly", async () => {
  refused(
    await staff.call("createVariant", { productId: "other-tee", size: "S", color: "Red", sku: "__RESERVED__", stock: 1 }),
    "That value cannot be used as-is.",
  );
});

// ---------------- filing status ----------------

await check("staff, not owner, cannot change a filing's status (permission-denied)", async () => {
  await denied(staff.call("updateFilingStatus", { filingId: "001", status: "scheduled" }), "permission-denied");
});

await check("a filing cannot skip a step (draft straight to live)", async () => {
  refused(
    await owner.call("updateFilingStatus", { filingId: "002", status: "live" }),
    "Only a scheduled filing can move to live, and this one is not scheduled any more. Reload to see where it is.",
  );
});

await check("going live without a public and member-access date is refused, loudly", async () => {
  succeeded(await owner.call("updateFilingStatus", { filingId: "001", status: "scheduled" }));
  refused(
    await owner.call("updateFilingStatus", { filingId: "001", status: "live" }),
    "Set a public date and a member-access date before taking this filing live.",
  );
  const doc = (await admin.db.doc("filings/001").get()).data();
  assert(doc?.status === "scheduled", `filing moved to ${doc?.status} anyway`);
});

// Filing 003's products: one made through the function (so it already holds
// copies of the timestamps), and one seeded straight into Firestore with no
// copies at all — so only the go-live transaction can have put them there.
succeeded(await staff.call("createProduct", { filingId: "003", slug: "night-tee", name: "Night Tee", kind: "tee", priceCents: 3400 }));
await admin.db.doc("products/seeded-tee").set({ filingId: "003", filingStatus: "draft", slug: "seeded-tee", name: "Seeded Tee" });

await check("going live pushes filingStatus, publicAt and memberAccessAt onto every product in the same write", async () => {
  succeeded(await owner.call("updateFilingStatus", { filingId: "003", status: "scheduled" }));
  succeeded(await owner.call("updateFilingStatus", { filingId: "003", status: "live" }));
  const filing = (await admin.db.doc("filings/003").get()).data();
  for (const slug of ["night-tee", "seeded-tee"]) {
    const p = (await admin.db.doc(`products/${slug}`).get()).data();
    assert(p?.filingStatus === "live", `${slug} filingStatus is ${p?.filingStatus}`);
    assert(p?.publicAt?.isEqual?.(filing.publicAt), `${slug} publicAt does not match the filing's`);
    assert(p?.memberAccessAt?.isEqual?.(filing.memberAccessAt), `${slug} memberAccessAt does not match the filing's`);
  }
  const state = (await admin.db.doc("state/currentFiling").get()).data();
  assert(state?.filingId === "003", `state/currentFiling is ${JSON.stringify(state)}`);
});

await check("a product added to a filing that is already live is live at once, as in D1", async () => {
  succeeded(await staff.call("createProduct", { filingId: "003", slug: "late-tee", name: "Late Tee", kind: "tee", priceCents: 3400 }));
  const p = (await admin.db.doc("products/late-tee").get()).data();
  const filing = (await admin.db.doc("filings/003").get()).data();
  assert(p?.filingStatus === "live" && p?.publicAt?.isEqual?.(filing.publicAt), JSON.stringify(p));
});

await check("a second live filing is refused, naming the one still live", async () => {
  succeeded(await owner.call("updateFilingStatus", { filingId: "004", status: "scheduled" }));
  refused(
    await owner.call("updateFilingStatus", { filingId: "004", status: "live" }),
    "Filing 003 is still live — close it before taking this one live.",
  );
});

await check("closing marks every product closed and clears state/currentFiling", async () => {
  succeeded(await owner.call("updateFilingStatus", { filingId: "003", status: "closed" }));
  for (const slug of ["night-tee", "seeded-tee", "late-tee"]) {
    const p = (await admin.db.doc(`products/${slug}`).get()).data();
    assert(p?.filingStatus === "closed", `${slug} filingStatus is ${p?.filingStatus}`);
  }
  const state = await admin.db.doc("state/currentFiling").get();
  assert(!state.exists, `state/currentFiling still holds ${JSON.stringify(state.data())}`);
});

await check("two filings taken live at the same instant: exactly one wins", async () => {
  succeeded(await owner.call("updateFilingStatus", { filingId: "005", status: "scheduled" }));
  // The Functions emulator starts a second worker for a function only once
  // its first is busy, and starting one takes far longer than a go-live call
  // runs — so two calls fired together on a cold pool simply run one after
  // the other, and prove nothing about concurrency. Warm it first: two slow-
  // enough calls at once leave two idle workers behind, and the real pair
  // below is then handed to both together. Whether they truly overlapped is
  // in the emulator log ("Beginning execution" twice before a "Finished"),
  // not something this script can see.
  await Promise.all([1, 2, 3].map(() =>
    owner.call("updateFilingStatus", { filingId: "no-such-filing", status: "closed" })));
  const results = await Promise.all([
    owner.call("updateFilingStatus", { filingId: "004", status: "live" }),
    owner.call("updateFilingStatus", { filingId: "005", status: "live" }),
  ]);
  const wins = results.filter((r) => r.ok);
  const losses = results.filter((r) => !r.ok);
  assert(wins.length === 1 && losses.length === 1, `results were ${JSON.stringify(results)}`);
  const winner = wins[0].data.id;
  assert(/is still live — close it before taking this one live\.$/.test(losses[0].error), `loser said "${losses[0].error}"`);
  assert(losses[0].error.startsWith(`Filing ${winner} `), `loser named the wrong filing: "${losses[0].error}"`);
  const live = await admin.db.collection("filings").where("status", "==", "live").get();
  assert(live.size === 1 && live.docs[0].id === winner, `live filings: ${live.docs.map((d) => d.id)}`);
  const state = (await admin.db.doc("state/currentFiling").get()).data();
  assert(state?.filingId === winner, `state/currentFiling is ${JSON.stringify(state)}`);
});

// The check above runs the real function, but whether its two transactions
// overlapped depends on scheduling. This one takes scheduling out of it: the
// same read-then-write pattern updateFilingStatus() uses — query what is live,
// then write — with the transaction held open between the two, so both have
// read "nothing is live" before either writes. It proves the database
// guarantee the function relies on, in a collection of its own so it cannot
// disturb the filings above.
await check("Firestore serializes the go-live pattern: two overlapping transactions, one goes live", async () => {
  const col = admin.db.collection("race-filings");
  const pointer = admin.db.doc("race-state/currentFiling");
  await col.doc("A").set({ status: "scheduled" });
  await col.doc("B").set({ status: "scheduled" });
  const attempts = { A: 0, B: 0 };
  const goLive = (id) => admin.db.runTransaction(async (t) => {
    attempts[id]++;
    const live = await t.get(col.where("status", "==", "live"));
    await new Promise((r) => setTimeout(r, 300));
    if (!live.empty) return { id, ok: false, blockedBy: live.docs[0].id };
    t.update(col.doc(id), { status: "live" });
    t.set(pointer, { filingId: id });
    return { id, ok: true };
  });
  const started = Date.now();
  const results = await Promise.all([goLive("A"), goLive("B")]);
  const elapsed = Date.now() - started;
  const liveNow = (await col.where("status", "==", "live").get()).docs.map((d) => d.id);
  console.log(`     race: results ${JSON.stringify(results)}, attempts ${JSON.stringify(attempts)}, ${elapsed}ms, live afterwards: [${liveNow}]`);
  assert(liveNow.length === 1, `${liveNow.length} filings are live afterwards: [${liveNow}]`);
  assert(results.filter((r) => r.ok).length === 1, `results: ${JSON.stringify(results)}`);
});

// ---------------- images ----------------

await check("a real JPEG uploads: the object lands in the bucket and on the product's images", async () => {
  const image = succeeded(await staff.call("uploadProductImage", { productId: "void-hood", fileBase64: JPEG.toString("base64") }));
  assert(image.path.startsWith("products/void-hood/") && image.path.endsWith(".jpg"), JSON.stringify(image));
  const [exists] = await admin.bucket.file(image.path).exists();
  assert(exists, `no object at ${image.path} in bucket ${admin.bucket.name}`);
  const [meta] = await admin.bucket.file(image.path).getMetadata();
  assert(meta.contentType === "image/jpeg", `stored as ${meta.contentType}`);
  const images = (await admin.db.doc("products/void-hood").get()).data()?.images ?? [];
  assert(images.some((i) => i.id === image.id && i.path === image.path && i.position === 0), JSON.stringify(images));
});

await check("an SVG is refused by its bytes, and nothing is stored", async () => {
  const [before] = await admin.bucket.getFiles({ prefix: "products/other-tee/" });
  refused(
    await staff.call("uploadProductImage", { productId: "other-tee", fileBase64: SVG.toString("base64") }),
    "That file is not a JPEG, PNG, WebP, AVIF or GIF.",
  );
  const [after] = await admin.bucket.getFiles({ prefix: "products/other-tee/" });
  assert(after.length === before.length, "an object was stored anyway");
});

await check("an upload for a product that does not exist is refused before anything is stored", async () => {
  refused(
    await staff.call("uploadProductImage", { productId: "no-such-tee", fileBase64: JPEG.toString("base64") }),
    "That product no longer exists.",
  );
  const [files] = await admin.bucket.getFiles({ prefix: "products/no-such-tee/" });
  assert(files.length === 0, "an object was stored anyway");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
