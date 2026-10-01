// Proves firestore.rules against the real Firestore emulator:
//
//   npm run test:rules
//
// which wraps `firebase emulators:exec --only firestore "node rules.test.mjs"`
// against the demo-degen-inc project id (no login, no real project). The
// emulator is a Java program and needs JDK 21 on PATH.
//
// The time-window checks use the emulator's own clock: one filing and one
// product go public a few seconds after the seed, the script checks them
// before that moment, waits it out, and checks again. Nothing fakes
// request.time.
//
// Every vote and submission sends createdAt: serverTimestamp(), as a real
// client must — the rules refuse any other value, and refuse its absence. Even
// the ones meant to fail send it, so each fails for its one intended reason.

import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import {
  collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where,
} from "firebase/firestore";

const testEnv = await initializeTestEnvironment({
  projectId: "demo-degen-inc",
  firestore: { rules: readFileSync("firestore.rules", "utf8") },
});
// Start from nothing, so this suite gives the same answers whether or not
// another one ran against the same emulator first.
await testEnv.clearFirestore();

const DAY = 24 * 60 * 60 * 1000;
const past = new Date(Date.now() - DAY);
const future = new Date(Date.now() + DAY);
// Far enough out that every "before" check below runs ahead of it, near
// enough that waiting for it is cheap.
const soon = new Date(Date.now() + 8000);

async function seed() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "filings/f-live"), { status: "live", memberAccessAt: past, publicAt: past });
    await setDoc(doc(db, "filings/f-draft"), { status: "draft" });
    await setDoc(doc(db, "products/p-live"), { filingId: "f-live", filingStatus: "live", memberAccessAt: past, publicAt: past, name: "Night Shift Tee" });
    await setDoc(doc(db, "products/p-draft"), { filingId: "f-draft", filingStatus: "draft", name: "Unreleased Tee" });
    await setDoc(doc(db, "products/p-closed"), { filingId: "f-old", filingStatus: "closed", name: "Old Tee" });

    // Open-call submissions, which votes point at.
    await setDoc(doc(db, "submissions/s-approved"), { name: "Artist A", contact: "a@example.com", workUrl: "https://example.com/a", status: "approved" });
    await setDoc(doc(db, "submissions/s-new"), { name: "Artist B", contact: "b@example.com", workUrl: "https://example.com/b", status: "new" });

    // Members' window: live, members in already, public in a few seconds.
    await setDoc(doc(db, "filings/f-members"), { status: "live", memberAccessAt: past, publicAt: soon });
    // Live, but not even members are in yet.
    await setDoc(doc(db, "filings/f-early"), { status: "live", memberAccessAt: future, publicAt: future });
    // Closed, with both timestamps still in the future: closed wins.
    await setDoc(doc(db, "filings/f-closed"), { status: "closed", memberAccessAt: future, publicAt: future });

    // Products carry their own copies of these fields, and the rule reads
    // those, not the filing's. These deliberately disagree with their
    // filings, so each result can only have come from the product's copy.
    // p-members is in its members' window although its filing (f-live) is
    // fully public; p-own-public is public although its filing (f-members)
    // is still members-only.
    await setDoc(doc(db, "products/p-members"), { filingId: "f-live", filingStatus: "live", memberAccessAt: past, publicAt: soon, name: "Members-first Tee" });
    await setDoc(doc(db, "products/p-early"), { filingId: "f-live", filingStatus: "live", memberAccessAt: future, publicAt: future, name: "Not Yet Tee" });
    await setDoc(doc(db, "products/p-own-public"), { filingId: "f-members", filingStatus: "live", memberAccessAt: past, publicAt: past, name: "Already Public Tee" });

    // Variants carry no visibility fields of their own; they answer to the
    // product named in their productId.
    await setDoc(doc(db, "variants/v-live"), { productId: "p-live", size: "S", color: "Black", stock: 4 });
    await setDoc(doc(db, "variants/v-m"), { productId: "p-members", size: "M", color: "Black", stock: 3 });
    await setDoc(doc(db, "variants/v-l"), { productId: "p-early", size: "L", color: "Black", stock: 5 });
  });
}

function anon() { return testEnv.unauthenticatedContext().firestore(); }
function member(uid) { return testEnv.authenticatedContext(uid, { role: "member" }).firestore(); }
function staff(uid) { return testEnv.authenticatedContext(uid, { role: "staff" }).firestore(); }
// No role claim at all: every account, until scripts/promote-role.mjs promotes it.
function noClaim(uid) { return testEnv.authenticatedContext(uid).firestore(); }

let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); console.log("PASS", label); pass++; }
  catch (e) { console.log("FAIL", label, "-", e.message); fail++; }
}

/** Where a check ran relative to `soon`, for the log line. */
function whenVsSoon() {
  const s = (Date.now() - soon.getTime()) / 1000;
  return s < 0 ? `${(-s).toFixed(1)}s before publicAt` : `${s.toFixed(1)}s after publicAt`;
}

await seed();

await check("anon cannot read a draft product", async () => {
  await assertFails(getDoc(doc(anon(), "products/p-draft")));
});

await check("anon can read a live product", async () => {
  await assertSucceeds(getDoc(doc(anon(), "products/p-live")));
});

await check("anon can read a closed product", async () => {
  await assertSucceeds(getDoc(doc(anon(), "products/p-closed")));
});

await check("staff can read a draft product", async () => {
  await assertSucceeds(getDoc(doc(staff("s1"), "products/p-draft")));
});

await check("no client, staff included, can write a product directly", async () => {
  await assertFails(setDoc(doc(staff("s1"), "products/p-live"), { name: "Hacked" }, { merge: true }));
});

await check("a member can vote for a live filing with a correctly-shaped id", async () => {
  await assertSucceeds(setDoc(doc(member("u1"), "votes/f-live_u1"), { filingId: "f-live", memberId: "u1", submissionId: "s-approved", createdAt: serverTimestamp() }));
});

await check("a member cannot vote for a draft filing", async () => {
  await assertFails(setDoc(doc(member("u2"), "votes/f-draft_u2"), { filingId: "f-draft", memberId: "u2", submissionId: "s-approved", createdAt: serverTimestamp() }));
});

await check("a member cannot vote as someone else (id/uid mismatch)", async () => {
  await assertFails(setDoc(doc(member("u3"), "votes/f-live_u4"), { filingId: "f-live", memberId: "u4", submissionId: "s-approved", createdAt: serverTimestamp() }));
});

// The subtle one. allow create is only evaluated when no document exists
// yet; a second attempt on the same id falls through to `allow update`,
// which is `false`. Confirmed against the emulator, whose trace shows the
// second write decided by 'update' alone.
await check("a member cannot vote twice in the same filing (create-vs-update on an existing id)", async () => {
  await assertFails(setDoc(doc(member("u1"), "votes/f-live_u1"), { filingId: "f-live", memberId: "u1", submissionId: "s-approved", createdAt: serverTimestamp() }));
});

await check("a member cannot write their own role", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users/u5"), { role: "member", email: "u5@example.com" });
  });
  await assertFails(updateDoc(doc(member("u5"), "users/u5"), { role: "owner" }));
});

await check("certificates are never client-writable, staff included", async () => {
  await assertFails(setDoc(doc(staff("s1"), "certificates/u1"), { number: 1 }));
});

await check("counters are never client-readable or client-writable", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "counters/certificates"), { value: 0 });
  });
  await assertFails(getDoc(doc(staff("s1"), "counters/certificates")));
});

// The four uniqueness lookups: Cloud Functions only, staff included.
for (const path of ["filingNumbers/001", "slugs/night-shift-tee", "skus/DGN-001-M-BLK", "variantKeys/p-live_S_Black"]) {
  await check(`${path.split("/")[0]} are never client-readable or client-writable`, async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path), { owner: "seeded" });
    });
    await assertFails(getDoc(doc(staff("s1"), path)));
    await assertFails(setDoc(doc(staff("s1"), `${path}-new`), { owner: "staff" }));
  });
}

// ---------------- submissions: what a public create may carry ----------------

await check("a submission created already approved with reviewedBy set is refused", async () => {
  await assertFails(setDoc(doc(anon(), "submissions/forged-1"), { name: "Me", contact: "me@example.com", workUrl: "https://example.com/me", status: "approved", reviewedBy: "owner-uid", createdAt: serverTimestamp() }));
});

await check("a submission created as approved, no review fields, is refused (status check alone)", async () => {
  await assertFails(setDoc(doc(anon(), "submissions/forged-2"), { name: "Me", contact: "me@example.com", workUrl: "https://example.com/me", status: "approved", createdAt: serverTimestamp() }));
});

await check("a submission created as new but with reviewedBy set is refused (field set alone)", async () => {
  await assertFails(setDoc(doc(anon(), "submissions/forged-3"), { name: "Me", contact: "me@example.com", workUrl: "https://example.com/me", status: "new", reviewedBy: "owner-uid", createdAt: serverTimestamp() }));
});

await check("a submission with a field outside the allowed set is refused", async () => {
  await assertFails(setDoc(doc(anon(), "submissions/extra-field"), { name: "Me", contact: "me@example.com", workUrl: "https://example.com/me", status: "new", priority: "high", createdAt: serverTimestamp() }));
});

await check("a submission missing a required field (workUrl) is refused", async () => {
  await assertFails(setDoc(doc(anon(), "submissions/missing-field"), { name: "Me", contact: "me@example.com", status: "new", createdAt: serverTimestamp() }));
});

await check("a submission with a backdated createdAt is refused", async () => {
  await assertFails(setDoc(doc(anon(), "submissions/backdated"), { name: "Me", contact: "me@example.com", workUrl: "https://example.com/me", status: "new", createdAt: past }));
});

await check("a submission with no createdAt is refused", async () => {
  await assertFails(setDoc(doc(anon(), "submissions/undated"), { name: "Me", contact: "me@example.com", workUrl: "https://example.com/me", status: "new" }));
});

await check("a plain, honest new submission still succeeds", async () => {
  await assertSucceeds(setDoc(doc(anon(), "submissions/honest"), { name: "Me", contact: "me@example.com", workUrl: "https://example.com/me", note: "Two designs attached.", status: "new", createdAt: serverTimestamp() }));
});

// ---------------- votes: what a vote may carry and point at ----------------

await check("a vote carrying an extra weight field is refused", async () => {
  await assertFails(setDoc(doc(member("u10"), "votes/f-live_u10"), { filingId: "f-live", memberId: "u10", submissionId: "s-approved", weight: 1000, createdAt: serverTimestamp() }));
});

await check("a vote referencing a submission that does not exist is refused", async () => {
  await assertFails(setDoc(doc(member("u11"), "votes/f-live_u11"), { filingId: "f-live", memberId: "u11", submissionId: "no-such-submission", createdAt: serverTimestamp() }));
});

await check("a vote referencing a submission that exists but is not approved is refused", async () => {
  await assertFails(setDoc(doc(member("u12"), "votes/f-live_u12"), { filingId: "f-live", memberId: "u12", submissionId: "s-new", createdAt: serverTimestamp() }));
});

await check("a vote referencing an approved submission succeeds", async () => {
  await assertSucceeds(setDoc(doc(member("u13"), "votes/f-live_u13"), { filingId: "f-live", memberId: "u13", submissionId: "s-approved", createdAt: serverTimestamp() }));
});

await check("a vote with a backdated createdAt is refused", async () => {
  await assertFails(setDoc(doc(member("u14"), "votes/f-live_u14"), { filingId: "f-live", memberId: "u14", submissionId: "s-approved", createdAt: past }));
});

await check("a vote with no createdAt is refused", async () => {
  await assertFails(setDoc(doc(member("u15"), "votes/f-live_u15"), { filingId: "f-live", memberId: "u15", submissionId: "s-approved" }));
});

// ---------------- filings: the members' window, before publicAt ----------------

await check(`a member can read a live filing in its members' window (${whenVsSoon()})`, async () => {
  await assertSucceeds(getDoc(doc(member("m1"), "filings/f-members")));
});

await check(`anon cannot read a live filing in its members' window (${whenVsSoon()})`, async () => {
  await assertFails(getDoc(doc(anon(), "filings/f-members")));
});

await check("a signed-in account with no role claim gets the members' window too", async () => {
  await assertSucceeds(getDoc(doc(noClaim("n1"), "filings/f-members")));
});

await check("a member cannot read a live filing before memberAccessAt", async () => {
  await assertFails(getDoc(doc(member("m1"), "filings/f-early")));
});

await check("staff can read a live filing nobody else can see yet", async () => {
  await assertSucceeds(getDoc(doc(staff("s1"), "filings/f-early")));
});

await check("a closed filing is readable by anon even with both timestamps in the future", async () => {
  await assertSucceeds(getDoc(doc(anon(), "filings/f-closed")));
});

// ---------------- products: the same windows, from the product's own copy ----------------

await check(`a member can read a product in its members' window (${whenVsSoon()})`, async () => {
  await assertSucceeds(getDoc(doc(member("m1"), "products/p-members")));
});

await check(`anon cannot read a product in its members' window, though its filing is fully public (${whenVsSoon()})`, async () => {
  await assertFails(getDoc(doc(anon(), "products/p-members")));
});

await check("a member cannot read a product before its memberAccessAt", async () => {
  await assertFails(getDoc(doc(member("m1"), "products/p-early")));
});

await check("anon can read a product whose own copy is public, though its filing is still members-only", async () => {
  await assertSucceeds(getDoc(doc(anon(), "products/p-own-public")));
});

// ---------------- variants: exactly as visible as their product ----------------

await check(`anon cannot read a variant of a product in its members' window (${whenVsSoon()})`, async () => {
  await assertFails(getDoc(doc(anon(), "variants/v-m")));
});

await check(`a member can read a variant of a product in its members' window (${whenVsSoon()})`, async () => {
  await assertSucceeds(getDoc(doc(member("m1"), "variants/v-m")));
});

await check("a member cannot read a variant of a product before its memberAccessAt", async () => {
  await assertFails(getDoc(doc(member("m1"), "variants/v-l")));
});

await check("staff can read a variant of a product nobody else can see yet", async () => {
  await assertSucceeds(getDoc(doc(staff("s1"), "variants/v-l")));
});

// Variant queries: the rule reads the product through resource.data.productId,
// so it can only be checked for a query that pins productId.
const variantsOf = (db, productId) => query(collection(db, "variants"), where("productId", "==", productId));

await check("a variant query filtered on a public product's productId is allowed, for anon", async () => {
  await assertSucceeds(getDocs(variantsOf(anon(), "p-live")));
});

await check(`a variant query filtered on a members'-window product is refused for anon (${whenVsSoon()})`, async () => {
  await assertFails(getDocs(variantsOf(anon(), "p-members")));
});

await check(`the same query is allowed for a member (${whenVsSoon()})`, async () => {
  await assertSucceeds(getDocs(variantsOf(member("m1"), "p-members")));
});

await check("a variant query without a productId filter is refused, even for a member", async () => {
  await assertFails(getDocs(collection(member("m1"), "variants")));
});

// The only size-S variant is v-live, on a public product — so this is refused
// for the missing filter, not for anything it would return.
await check("a variant query filtered on another field is refused, though all it matches is public", async () => {
  await assertFails(getDocs(query(collection(anon(), "variants"), where("size", "==", "S"))));
});

await check("staff can query variants without a productId filter", async () => {
  await assertSucceeds(getDocs(collection(staff("s1"), "variants")));
});

// ---------------- after publicAt has passed on the emulator's clock ----------------

const wait = soon.getTime() + 1500 - Date.now();
if (wait > 0) await new Promise((r) => setTimeout(r, wait));

await check(`anon can read the members'-window filing once publicAt has passed (${whenVsSoon()})`, async () => {
  await assertSucceeds(getDoc(doc(anon(), "filings/f-members")));
});

await check(`anon can read the members'-window product once publicAt has passed (${whenVsSoon()})`, async () => {
  await assertSucceeds(getDoc(doc(anon(), "products/p-members")));
});

await check(`anon can read that product's variant once publicAt has passed (${whenVsSoon()})`, async () => {
  await assertSucceeds(getDoc(doc(anon(), "variants/v-m")));
});

await check(`and a variant query filtered on it is allowed for anon now (${whenVsSoon()})`, async () => {
  await assertSucceeds(getDocs(variantsOf(anon(), "p-members")));
});

console.log(`\n${pass} passed, ${fail} failed`);
await testEnv.cleanup();
if (fail > 0) process.exit(1);
