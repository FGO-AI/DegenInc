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
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import { getStorage as getAdminStorage } from "firebase-admin/storage";
import { initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-degen-inc";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const run = promisify(execFile);

// Start from nothing, so this suite gives the same answers whether or not
// another one ran against the same emulators first.
await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });

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

/**
 * Changes a role through the real script, the way the owner would. The script
 * also revokes the account's tokens. Firebase records both a revocation and a
 * sign-in to the second, and counts a token revoked only if its sign-in is
 * strictly earlier — so a sign-in in the same second as the revocation
 * survives it. Waiting into the next second first keeps that from deciding the
 * test.
 */
async function setRole(account, role) {
  await new Promise((r) => setTimeout(r, 1100));
  await run(process.execPath, ["scripts/promote-role.mjs", account.email, role], { env: process.env });
}

/**
 * Promotes, then signs in again: the script revokes the account's tokens, so
 * the only way to a token carrying the new role is a fresh sign-in.
 */
async function promote(account, role) {
  await setRole(account, role);
  ({ user: account.user } = await signInWithEmailAndPassword(account.auth, account.email, "password-123"));
}

/** Gets past the staff guard and stops at validation: proves the caller is staff, writes nothing. */
const pastTheGuard = (account) => account.call("createFiling", { number: 0, title: "Guard check" });
const GUARD_PASSED = "Filing number must be a whole number from 1 to 999.";

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
const data = async (path) => (await admin.db.doc(path).get()).data();
const count = async (q) => (await q.count().get()).data().count;

/**
 * Two calls fired at the same instant, on a warmed pool.
 *
 * The Functions emulator starts a second worker for a function only once its
 * first is busy, and starting one takes far longer than a call runs — so two
 * calls fired together on a cold pool simply run one after the other, and
 * prove nothing about concurrency. `warm` is three refused calls at once that
 * still read Firestore, slow enough to leave several idle workers behind; the
 * real pair is then handed to two of them together. Whether the pair truly
 * overlapped is in the emulator log ("Beginning execution" twice before a
 * "Finished"), not something this script can see.
 */
async function race(account, name, warm, a, b) {
  await Promise.all([warm, warm, warm].map((w) => account.call(name, w)));
  return Promise.all([account.call(name, a), account.call(name, b)]);
}
function oneWinner(results, error) {
  const wins = results.filter((r) => r.ok);
  const losses = results.filter((r) => !r.ok);
  assert(wins.length === 1 && losses.length === 1, `results were ${JSON.stringify(results)}`);
  assert(losses[0].error === error, `the loser said "${losses[0].error}", expected "${error}"`);
  return wins[0].data;
}

const HOUR = 60 * 60 * 1000;
const memberAccessAt = new Date(Date.now() + HOUR).toISOString();
const publicAt = new Date(Date.now() + 2 * HOUR).toISOString();

// A real JPEG header (SOI + APP0/JFIF) padded to the 12 bytes the sniffer needs.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

// ---------------- accounts and roles ----------------

let member, staff, owner;

await check("a fresh sign-up gets a users doc with role 'member', and no role claim", async () => {
  member = await signUp("member@example.com");
  await settled(member.uid);
  const docRole = (await data(`users/${member.uid}`))?.role;
  assert(docRole === "member", `users doc role is ${docRole}`);
  const record = await admin.auth.getUser(member.uid);
  assert(record.customClaims?.role === undefined, `the trigger set a claim: ${JSON.stringify(record.customClaims)}`);
});

await check("a signed-out caller is refused (unauthenticated)", async () => {
  await denied(client().call("createFiling", { number: 900, title: "Nope" }), "unauthenticated");
});

await check("a member is refused a staff-only function (permission-denied)", async () => {
  await member.user.getIdToken(true);
  await denied(member.call("createFiling", { number: 900, title: "Nope" }), "permission-denied");
});

await check("a promotion revokes the old token at once, and the next sign-in carries the new role", async () => {
  staff = await signUp("staff@example.com");
  await settled(staff.uid);
  await staff.user.getIdToken(); // the member token, cached and unexpired
  await setRole(staff, "staff");
  // The cached token has most of its hour left, but it was revoked: refused.
  await denied(pastTheGuard(staff), "unauthenticated");
  // In production a revoked refresh token cannot be refreshed at all; the
  // Auth emulator still allows it. Either way a refreshed token is refused,
  // because it still carries the sign-in from before the revocation — and
  // that is the property the guard relies on.
  await staff.user.getIdToken(true).catch(() => {});
  await denied(pastTheGuard(staff), "unauthenticated");
  // A fresh sign-in is the way back, and it carries the new role.
  ({ user: staff.user } = await signInWithEmailAndPassword(staff.auth, staff.email, "password-123"));
  refused(await pastTheGuard(staff), GUARD_PASSED);
  const record = await admin.auth.getUser(staff.uid);
  assert(record.customClaims?.role === "staff", `claim is ${JSON.stringify(record.customClaims)}`);
  const docRole = (await data(`users/${staff.uid}`))?.role;
  assert(docRole === "staff", `users doc role is ${docRole}`);
});

await check("a demoted staff member is refused at once, not when their token expires", async () => {
  const leaving = await signUp("leaving@example.com");
  await settled(leaving.uid);
  await promote(leaving, "staff");
  refused(await pastTheGuard(leaving), GUARD_PASSED);
  await setRole(leaving, "member");
  await denied(pastTheGuard(leaving), "unauthenticated");
});

owner = await signUp("owner@example.com");
await settled(owner.uid);
await promote(owner, "owner");

await check("onUserCreate never touches a role claim, so a promotion cannot be lost to it", async () => {
  // Created and promoted in one breath, the way a seed script would, so the
  // promotion and the trigger land in whatever order they land. The trigger
  // writes no claim, so the order no longer matters to the claim. (It once
  // set 'member', and this exact check caught it demoting an owner.)
  const created = await admin.auth.createUser({ email: "seeded-owner@example.com", password: "password-123" });
  await admin.auth.setCustomUserClaims(created.uid, { role: "owner" });
  await settled(created.uid);
  const record = await admin.auth.getUser(created.uid);
  assert(record.customClaims?.role === "owner", `claim is ${JSON.stringify(record.customClaims)}`);
});

// ---------------- filings ----------------

let f1, f2, f3, f4, f5;

await check("staff can create a filing, as a draft, with a random id, its two times and a number lookup", async () => {
  f1 = succeeded(await staff.call("createFiling", { number: 1, title: "Night Shift", memberAccessAt, publicAt }));
  assert(f1.status === "draft" && /^[A-Za-z0-9]{20}$/.test(f1.id), JSON.stringify(f1));
  const doc = await data(`filings/${f1.id}`);
  assert(doc?.status === "draft" && doc?.number === 1, JSON.stringify(doc));
  assert(doc?.memberAccessAt?.toDate?.().toISOString() === memberAccessAt && doc?.publicAt?.toDate?.().toISOString() === publicAt,
    "the two times were not stored as sent");
  const lookup = await data("filingNumbers/001");
  assert(lookup?.filingId === f1.id, `filingNumbers/001 is ${JSON.stringify(lookup)}`);
});

await check("a duplicate filing number is refused with the console's own message", async () => {
  refused(await staff.call("createFiling", { number: 1, title: "Again", memberAccessAt, publicAt }), "Filing 001 already exists.");
  assert((await count(admin.db.collection("filings").where("number", "==", 1))) === 1, "a second filing 001 was written");
});

await check("a filing without both times is refused", async () => {
  refused(await staff.call("createFiling", { number: 9, title: "Untimed" }), "Set when members get in and when the public does.");
  refused(await staff.call("createFiling", { number: 9, title: "Half", memberAccessAt }), "Set when members get in and when the public does.");
});

await check("a public date that is not after the members' date is refused — equal included", async () => {
  refused(
    await staff.call("createFiling", { number: 9, title: "Backwards", memberAccessAt: publicAt, publicAt: memberAccessAt }),
    "The public date has to be after the members' date.",
  );
  refused(
    await staff.call("createFiling", { number: 9, title: "Same moment", memberAccessAt, publicAt: memberAccessAt }),
    "The public date has to be after the members' date.",
  );
  assert(!(await admin.db.doc("filingNumbers/009").get()).exists, "a refused filing claimed its number anyway");
});

f2 = succeeded(await staff.call("createFiling", { number: 2, title: "Second", memberAccessAt, publicAt }));
f3 = succeeded(await staff.call("createFiling", { number: 3, title: "Timed", memberAccessAt, publicAt }));
f4 = succeeded(await staff.call("createFiling", { number: 4, title: "Timed too", memberAccessAt, publicAt }));
f5 = succeeded(await staff.call("createFiling", { number: 5, title: "Timed three", memberAccessAt, publicAt }));
const numberOf = { [f1.id]: "001", [f2.id]: "002", [f3.id]: "003", [f4.id]: "004", [f5.id]: "005" };

// ---------------- products ----------------

let voidHood, otherTee;

await check("staff can create a product with a random id and a slug lookup, copying its filing's state", async () => {
  voidHood = succeeded(await staff.call("createProduct", {
    filingId: f1.id, slug: "void-hood", name: "Void Hood", kind: "hoodie", priceCents: 6500,
  }));
  assert(voidHood.slug === "void-hood" && /^[A-Za-z0-9]{20}$/.test(voidHood.id), JSON.stringify(voidHood));
  const doc = await data(`products/${voidHood.id}`);
  assert(doc?.slug === "void-hood" && doc?.filingStatus === "draft" && doc?.position === 0 && Array.isArray(doc?.images), JSON.stringify(doc));
  const lookup = await data("slugs/void-hood");
  assert(lookup?.productId === voidHood.id, `slugs/void-hood is ${JSON.stringify(lookup)}`);
});

await check("a duplicate slug is refused, even under a different filing", async () => {
  refused(
    await staff.call("createProduct", { filingId: f2.id, slug: "void-hood", name: "Other", kind: "tee", priceCents: 100 }),
    'The slug "void-hood" is already taken.',
  );
  assert((await count(admin.db.collection("products").where("slug", "==", "void-hood"))) === 1, "a second void-hood was written");
});

await check("a product under a filing that does not exist is refused", async () => {
  refused(
    await staff.call("createProduct", { filingId: "no-such-filing", slug: "orphan-tee", name: "Orphan", kind: "tee", priceCents: 100 }),
    "That filing no longer exists.",
  );
  assert(!(await admin.db.doc("slugs/orphan-tee").get()).exists, "the refused product's slug was claimed anyway");
});

otherTee = succeeded(await staff.call("createProduct", { filingId: f2.id, slug: "other-tee", name: "Other Tee", kind: "tee", priceCents: 3000 }));

// ---------------- variants ----------------

let v1;

await check("staff can create a variant: top-level, random id, productId field, SKU and size/colour lookups", async () => {
  v1 = succeeded(await staff.call("createVariant", { productId: voidHood.id, size: "M", color: "Black", sku: "DGN-001-M-BLK", stock: 10 }));
  assert(/^[A-Za-z0-9]{20}$/.test(v1.id), JSON.stringify(v1));
  const doc = await data(`variants/${v1.id}`);
  assert(doc?.productId === voidHood.id && doc?.size === "M" && doc?.color === "Black" && doc?.stock === 10, JSON.stringify(doc));
  const sku = await data("skus/DGN-001-M-BLK");
  assert(sku?.productId === voidHood.id && sku?.variantId === v1.id, `skus/DGN-001-M-BLK is ${JSON.stringify(sku)}`);
  const key = await data(`variantKeys/${voidHood.id}_M_Black`);
  assert(key?.variantId === v1.id, `variantKeys/${voidHood.id}_M_Black is ${JSON.stringify(key)}`);
});

// The bug the old size_color ids had: M / Black on a second product collided
// with the first product's, because the id was only unique within one product.
await check("the same size and colour on a different product is a different variant", async () => {
  const v = succeeded(await staff.call("createVariant", { productId: otherTee.id, size: "M", color: "Black", sku: "DGN-002-M-BLK", stock: 4 }));
  assert(v.id !== v1.id, "both variants got the same id");
  assert((await data(`variants/${v1.id}`))?.productId === voidHood.id, "the first variant was overwritten");
});

await check("a second variant with the same size and color on one product is refused", async () => {
  refused(
    await staff.call("createVariant", { productId: voidHood.id, size: "M", color: "Black", sku: "DGN-001-M-BLK-2", stock: 1 }),
    "This product already has a M / Black variant.",
  );
  assert(!(await admin.db.doc("skus/DGN-001-M-BLK-2").get()).exists, "the refused variant's SKU was claimed anyway");
});

await check("a duplicate SKU is refused across products, and nothing is half-written", async () => {
  refused(
    await staff.call("createVariant", { productId: otherTee.id, size: "L", color: "White", sku: "DGN-001-M-BLK", stock: 1 }),
    "SKU DGN-001-M-BLK is already in use.",
  );
  assert(!(await admin.db.doc(`variantKeys/${otherTee.id}_L_White`).get()).exists, "the refused variant's size/colour was claimed anyway");
  assert((await count(admin.db.collection("variants").where("sku", "==", "DGN-001-M-BLK"))) === 1, "a second variant with that SKU was written");
});

await check("a SKU Firestore reserves as a document id (__x__) is refused cleanly", async () => {
  refused(
    await staff.call("createVariant", { productId: otherTee.id, size: "S", color: "Red", sku: "__RESERVED__", stock: 1 }),
    "That value cannot be used as-is.",
  );
});

// ---------------- uniqueness under real concurrency ----------------
// Each lookup is created with create() in the transaction that owns the value.
// Two overlapping creates of one value: exactly one may win, the other must
// fail with its sentence, and nothing of the loser's may be left behind.

await check("two overlapping creates of one filing number: one wins, one is refused", async () => {
  const results = await race(staff, "createFiling", { number: 1, title: "warm", memberAccessAt, publicAt },
    { number: 60, title: "Race A", memberAccessAt, publicAt }, { number: 60, title: "Race B", memberAccessAt, publicAt });
  const winner = oneWinner(results, "Filing 060 already exists.");
  assert((await count(admin.db.collection("filings").where("number", "==", 60))) === 1, "two filings 060 exist");
  assert((await data("filingNumbers/060"))?.filingId === winner.id, "the lookup does not point at the winner");
});

await check("two overlapping creates of one slug: one wins, one is refused", async () => {
  const results = await race(staff, "createProduct",
    { filingId: f2.id, slug: "void-hood", name: "warm", kind: "tee", priceCents: 1 },
    { filingId: f1.id, slug: "race-tee", name: "Race A", kind: "tee", priceCents: 1000 },
    { filingId: f2.id, slug: "race-tee", name: "Race B", kind: "tee", priceCents: 1000 });
  const winner = oneWinner(results, 'The slug "race-tee" is already taken.');
  assert((await count(admin.db.collection("products").where("slug", "==", "race-tee"))) === 1, "two race-tee products exist");
  assert((await data("slugs/race-tee"))?.productId === winner.id, "the lookup does not point at the winner");
});

await check("two overlapping creates of one SKU, on different products: one wins, one is refused", async () => {
  const results = await race(staff, "createVariant",
    { productId: otherTee.id, size: "XS", color: "Grey", sku: "DGN-001-M-BLK", stock: 1 },
    { productId: voidHood.id, size: "L", color: "Red", sku: "RACE-SKU", stock: 1 },
    { productId: otherTee.id, size: "L", color: "Red", sku: "RACE-SKU", stock: 1 });
  const winner = oneWinner(results, "SKU RACE-SKU is already in use.");
  assert((await count(admin.db.collection("variants").where("sku", "==", "RACE-SKU"))) === 1, "two variants hold RACE-SKU");
  assert((await data("skus/RACE-SKU"))?.variantId === winner.id, "the lookup does not point at the winner");
  const loserProduct = (await data(`variants/${winner.id}`))?.productId === voidHood.id ? otherTee.id : voidHood.id;
  assert(!(await admin.db.doc(`variantKeys/${loserProduct}_L_Red`).get()).exists, "the loser's size/colour lookup was left behind");
});

await check("two overlapping creates of one size and colour on a product: one wins, one is refused", async () => {
  const results = await race(staff, "createVariant",
    { productId: otherTee.id, size: "XS", color: "Grey", sku: "DGN-001-M-BLK", stock: 1 },
    { productId: voidHood.id, size: "XL", color: "Green", sku: "RACE-XL-A", stock: 1 },
    { productId: voidHood.id, size: "XL", color: "Green", sku: "RACE-XL-B", stock: 1 });
  const winner = oneWinner(results, "This product already has a XL / Green variant.");
  const same = admin.db.collection("variants").where("productId", "==", voidHood.id).where("size", "==", "XL").where("color", "==", "Green");
  assert((await count(same)) === 1, "two XL / Green variants exist on the product");
  assert((await data(`variantKeys/${voidHood.id}_XL_Green`))?.variantId === winner.id, "the lookup does not point at the winner");
  const loserSku = winner.sku === "RACE-XL-A" ? "RACE-XL-B" : "RACE-XL-A";
  assert(!(await admin.db.doc(`skus/${loserSku}`).get()).exists, "the loser's SKU lookup was left behind");
});

// The checks above run the real functions, but whether each pair overlapped
// depends on scheduling. This takes scheduling out of it: two transactions
// both read that a lookup is absent, held open so neither writes until both
// have read, then both create it. It proves the guarantee the lookups rest on.
await check("Firestore lets only one of two overlapping transactions create the same lookup", async () => {
  const ref = admin.db.doc("race-lookups/one-value");
  const attempts = { A: 0, B: 0 };
  const claim = (id) => admin.db.runTransaction(async (t) => {
    attempts[id]++;
    const taken = (await t.get(ref)).exists;
    await new Promise((r) => setTimeout(r, 300));
    if (taken) return { id, ok: false };
    t.create(ref, { owner: id });
    return { id, ok: true };
  }).catch((e) => ({ id, ok: false, error: `${e.code} ${e.message}`.slice(0, 80) }));
  const results = await Promise.all([claim("A"), claim("B")]);
  const owner = (await data("race-lookups/one-value"))?.owner;
  console.log(`     lookup race: results ${JSON.stringify(results)}, attempts ${JSON.stringify(attempts)}, owner ${owner}`);
  assert(results.filter((r) => r.ok).length === 1, `results: ${JSON.stringify(results)}`);
  assert(results.find((r) => r.ok).id === owner, "the document's owner is not the transaction that reported winning");
});

// ---------------- filing status ----------------

await check("staff, not owner, cannot change a filing's status (permission-denied)", async () => {
  await denied(staff.call("updateFilingStatus", { filingId: f1.id, status: "scheduled" }), "permission-denied");
});

await check("a filing cannot skip a step (draft straight to live)", async () => {
  refused(
    await owner.call("updateFilingStatus", { filingId: f2.id, status: "live" }),
    "Only a scheduled filing can move to live, and this one is not scheduled any more. Reload to see where it is.",
  );
});

await check("going live without both times is refused, loudly — for a filing made before they were required", async () => {
  // createFiling no longer makes one, so it is seeded the way old data would be.
  const legacy = admin.db.collection("filings").doc();
  await legacy.set({ number: 70, title: "Legacy", status: "scheduled" });
  refused(
    await owner.call("updateFilingStatus", { filingId: legacy.id, status: "live" }),
    "Set a public date and a member-access date before taking this filing live.",
  );
  assert((await data(`filings/${legacy.id}`))?.status === "scheduled", "the filing moved anyway");
});

// Filing 003's products: one made through the function (so it already holds
// copies of the timestamps), and one seeded straight into Firestore with no
// copies at all — so only the status transaction can have put them there.
const nightTee = succeeded(await staff.call("createProduct", { filingId: f3.id, slug: "night-tee", name: "Night Tee", kind: "tee", priceCents: 3400 }));
const seededTee = admin.db.collection("products").doc();
await seededTee.set({ filingId: f3.id, filingStatus: "draft", slug: "seeded-tee", name: "Seeded Tee" });
let lateTee;

/** Every product of the filing holds exactly the filing's status and times. */
async function productsMatch(filingId, status, productIds) {
  const filing = await data(`filings/${filingId}`);
  assert(filing.status === status, `the filing is ${filing.status}, not ${status}`);
  for (const id of productIds) {
    const p = await data(`products/${id}`);
    assert(p?.filingStatus === status, `${p?.slug} filingStatus is ${p?.filingStatus}`);
    assert(p?.publicAt?.isEqual?.(filing.publicAt), `${p?.slug} publicAt does not match the filing's`);
    assert(p?.memberAccessAt?.isEqual?.(filing.memberAccessAt), `${p?.slug} memberAccessAt does not match the filing's`);
  }
}

await check("scheduling writes the status and both times onto every product, in the same write", async () => {
  succeeded(await owner.call("updateFilingStatus", { filingId: f3.id, status: "scheduled" }));
  await productsMatch(f3.id, "scheduled", [nightTee.id, seededTee.id]);
});

await check("going live writes the status and both times onto every product, in the same write", async () => {
  succeeded(await owner.call("updateFilingStatus", { filingId: f3.id, status: "live" }));
  await productsMatch(f3.id, "live", [nightTee.id, seededTee.id]);
  assert((await data("state/currentFiling"))?.filingId === f3.id, "state/currentFiling does not point at filing 003");
});

await check("a product added to a filing that is already live is live at once, with no review step", async () => {
  lateTee = succeeded(await staff.call("createProduct", { filingId: f3.id, slug: "late-tee", name: "Late Tee", kind: "tee", priceCents: 3400 }));
  const p = await data(`products/${lateTee.id}`);
  const filing = await data(`filings/${f3.id}`);
  assert(p?.filingStatus === "live" && p?.publicAt?.isEqual?.(filing.publicAt), JSON.stringify(p));
});

await check("a second live filing is refused, naming the one still live", async () => {
  succeeded(await owner.call("updateFilingStatus", { filingId: f4.id, status: "scheduled" }));
  refused(
    await owner.call("updateFilingStatus", { filingId: f4.id, status: "live" }),
    "Filing 003 is still live — close it before taking this one live.",
  );
});

await check("closing marks every product closed and clears state/currentFiling", async () => {
  succeeded(await owner.call("updateFilingStatus", { filingId: f3.id, status: "closed" }));
  for (const id of [nightTee.id, seededTee.id, lateTee.id]) {
    const p = await data(`products/${id}`);
    assert(p?.filingStatus === "closed", `${p?.slug} filingStatus is ${p?.filingStatus}`);
  }
  const state = await admin.db.doc("state/currentFiling").get();
  assert(!state.exists, `state/currentFiling still holds ${JSON.stringify(state.data())}`);
});

await check("two filings taken live at the same instant: exactly one wins", async () => {
  succeeded(await owner.call("updateFilingStatus", { filingId: f5.id, status: "scheduled" }));
  const results = await race(owner, "updateFilingStatus", { filingId: "no-such-filing", status: "closed" },
    { filingId: f4.id, status: "live" }, { filingId: f5.id, status: "live" });
  const wins = results.filter((r) => r.ok);
  const losses = results.filter((r) => !r.ok);
  assert(wins.length === 1 && losses.length === 1, `results were ${JSON.stringify(results)}`);
  const winner = wins[0].data.id;
  assert(losses[0].error === `Filing ${numberOf[winner]} is still live — close it before taking this one live.`, `loser said "${losses[0].error}"`);
  const live = await admin.db.collection("filings").where("status", "==", "live").get();
  assert(live.size === 1 && live.docs[0].id === winner, `live filings: ${live.docs.map((d) => d.id)}`);
  assert((await data("state/currentFiling"))?.filingId === winner, "state/currentFiling does not point at the winner");
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
  const image = succeeded(await staff.call("uploadProductImage", { productId: voidHood.id, fileBase64: JPEG.toString("base64") }));
  assert(image.path.startsWith(`products/${voidHood.id}/`) && image.path.endsWith(".jpg"), JSON.stringify(image));
  const [exists] = await admin.bucket.file(image.path).exists();
  assert(exists, `no object at ${image.path} in bucket ${admin.bucket.name}`);
  const [meta] = await admin.bucket.file(image.path).getMetadata();
  assert(meta.contentType === "image/jpeg", `stored as ${meta.contentType}`);
  const images = (await data(`products/${voidHood.id}`))?.images ?? [];
  assert(images.some((i) => i.id === image.id && i.path === image.path && i.position === 0), JSON.stringify(images));
});

await check("an SVG is refused by its bytes, and nothing is stored", async () => {
  const [before] = await admin.bucket.getFiles({ prefix: `products/${otherTee.id}/` });
  refused(
    await staff.call("uploadProductImage", { productId: otherTee.id, fileBase64: SVG.toString("base64") }),
    "That file is not a JPEG, PNG, WebP, AVIF or GIF.",
  );
  const [after] = await admin.bucket.getFiles({ prefix: `products/${otherTee.id}/` });
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

// ---------------- certificates: issued for a paid order, never for an unpaid one ----------------
// issueCertificate is not deployed yet — nothing marks an order paid until
// Stripe exists — so it is called directly, from the built functions package.

const { issueCertificate } = createRequire(import.meta.url)("./functions/lib/certificates.js");

async function seedOrder(memberId, status) {
  const ref = admin.db.collection("orders").doc();
  await ref.set({ memberId, status, items: [], totalCents: 0, createdAt: FieldValue.serverTimestamp() });
  return ref.id;
}
const counterValue = async () => (await data("counters/certificates"))?.value ?? 0;
const outcome = (promise) => promise.then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, error: e.message }));

await check("an unpaid order is refused a certificate, and uses no number", async () => {
  const before = await counterValue();
  const result = await outcome(issueCertificate(await seedOrder("m-unpaid", "pending")));
  assert(!result.ok && result.error === "Only a paid order is issued a certificate.", JSON.stringify(result));
  assert((await counterValue()) === before, "the counter moved");
  assert(!(await admin.db.doc("certificates/m-unpaid").get()).exists, "a certificate was written");
});

await check("a missing order is refused a certificate", async () => {
  const result = await outcome(issueCertificate("no-such-order"));
  assert(!result.ok && result.error === "There is no such order.", JSON.stringify(result));
});

await check("a paid order is issued the next number, and the counter moves by exactly one", async () => {
  const before = await counterValue();
  const orderId = await seedOrder("m-one", "paid");
  const result = await issueCertificate(orderId);
  assert(result.issued && result.number === before + 1, JSON.stringify(result));
  const cert = await data("certificates/m-one");
  assert(cert?.number === before + 1 && cert?.orderId === orderId && cert?.memberId === "m-one" && cert?.issuedAt, JSON.stringify(cert));
  assert((await counterValue()) === before + 1, `the counter is ${await counterValue()}`);
});

await check("a member's second paid order gets the same certificate back, and uses no number", async () => {
  const before = await counterValue();
  const first = (await data("certificates/m-one")).number;
  const result = await issueCertificate(await seedOrder("m-one", "paid"));
  assert(!result.issued && result.number === first, JSON.stringify(result));
  assert((await counterValue()) === before, "the counter moved");
});

await check("two members issued at the same instant get consecutive numbers: none shared, none skipped", async () => {
  const before = await counterValue();
  const [a, b] = await Promise.all([
    issueCertificate(await seedOrder("m-a", "paid")),
    issueCertificate(await seedOrder("m-b", "paid")),
  ]);
  const numbers = [a.number, b.number].sort((x, y) => x - y);
  assert(a.issued && b.issued && numbers[0] === before + 1 && numbers[1] === before + 2, JSON.stringify({ a, b, before }));
  assert((await counterValue()) === before + 2, `the counter is ${await counterValue()}`);
});

await check("one member's two paid orders issued at the same instant: one certificate, one number", async () => {
  const before = await counterValue();
  const [first, second] = await Promise.all([
    issueCertificate(await seedOrder("m-c", "paid")),
    issueCertificate(await seedOrder("m-c", "paid")),
  ]);
  assert([first, second].filter((r) => r.issued).length === 1, JSON.stringify({ first, second }));
  assert(first.number === second.number && first.number === before + 1, JSON.stringify({ first, second, before }));
  assert((await counterValue()) === before + 1, `the counter is ${await counterValue()}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
