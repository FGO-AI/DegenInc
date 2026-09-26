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

import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import {
  doc, getDoc, serverTimestamp, setDoc, updateDoc,
} from "firebase/firestore";

const testEnv = await initializeTestEnvironment({
  projectId: "demo-degen-inc",
  firestore: { rules: readFileSync("firestore.rules", "utf8") },
});

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
  });
}

function anon() { return testEnv.unauthenticatedContext().firestore(); }
function member(uid) { return testEnv.authenticatedContext(uid, { role: "customer" }).firestore(); }
function staff(uid) { return testEnv.authenticatedContext(uid, { role: "staff" }).firestore(); }
// Signed up a moment ago: the Cloud Function has not set the role claim yet.
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
  await assertSucceeds(setDoc(doc(member("u1"), "votes/f-live_u1"), { filingId: "f-live", memberId: "u1", submissionId: "s-approved" }));
});

await check("a member cannot vote for a draft filing", async () => {
  await assertFails(setDoc(doc(member("u2"), "votes/f-draft_u2"), { filingId: "f-draft", memberId: "u2", submissionId: "s-approved" }));
});

await check("a member cannot vote as someone else (id/uid mismatch)", async () => {
  await assertFails(setDoc(doc(member("u3"), "votes/f-live_u4"), { filingId: "f-live", memberId: "u4", submissionId: "s-approved" }));
});

// The subtle one. allow create is only evaluated when no document exists
// yet; a second attempt on the same id falls through to `allow update`,
// which is `false`. Confirmed against the emulator, whose trace shows the
// second write decided by 'update' alone.
await check("a member cannot vote twice in the same filing (create-vs-update on an existing id)", async () => {
  await assertFails(setDoc(doc(member("u1"), "votes/f-live_u1"), { filingId: "f-live", memberId: "u1", submissionId: "s-approved" }));
});

await check("a member cannot write their own role", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "users/u5"), { role: "customer", email: "u5@example.com" });
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

// ---------------- submissions: what a public create may carry ----------------

await check("a submission created already approved with reviewedBy set is refused", async () => {
  await assertFails(setDoc(doc(anon(), "submissions/forged-1"), { name: "Me", contact: "me@example.com", workUrl: "https://example.com/me", status: "approved", reviewedBy: "owner-uid" }));
});

await check("a submission created as approved, no review fields, is refused (status check alone)", async () => {
  await assertFails(setDoc(doc(anon(), "submissions/forged-2"), { name: "Me", contact: "me@example.com", workUrl: "https://example.com/me", status: "approved" }));
});

await check("a submission created as new but with reviewedBy set is refused (field set alone)", async () => {
  await assertFails(setDoc(doc(anon(), "submissions/forged-3"), { name: "Me", contact: "me@example.com", workUrl: "https://example.com/me", status: "new", reviewedBy: "owner-uid" }));
});

await check("a submission with a field outside the allowed set is refused", async () => {
  await assertFails(setDoc(doc(anon(), "submissions/extra-field"), { name: "Me", contact: "me@example.com", workUrl: "https://example.com/me", status: "new", priority: "high" }));
});

await check("a submission missing a required field (workUrl) is refused", async () => {
  await assertFails(setDoc(doc(anon(), "submissions/missing-field"), { name: "Me", contact: "me@example.com", status: "new" }));
});

await check("a plain, honest new submission still succeeds", async () => {
  await assertSucceeds(setDoc(doc(anon(), "submissions/honest"), { name: "Me", contact: "me@example.com", workUrl: "https://example.com/me", note: "Two designs attached.", status: "new", createdAt: serverTimestamp() }));
});

// ---------------- votes: what a vote may carry and point at ----------------

await check("a vote carrying an extra weight field is refused", async () => {
  await assertFails(setDoc(doc(member("u10"), "votes/f-live_u10"), { filingId: "f-live", memberId: "u10", submissionId: "s-approved", weight: 1000 }));
});

await check("a vote referencing a submission that does not exist is refused", async () => {
  await assertFails(setDoc(doc(member("u11"), "votes/f-live_u11"), { filingId: "f-live", memberId: "u11", submissionId: "no-such-submission" }));
});

await check("a vote referencing a submission that exists but is not approved is refused", async () => {
  await assertFails(setDoc(doc(member("u12"), "votes/f-live_u12"), { filingId: "f-live", memberId: "u12", submissionId: "s-new" }));
});

await check("a vote referencing an approved submission succeeds", async () => {
  await assertSucceeds(setDoc(doc(member("u13"), "votes/f-live_u13"), { filingId: "f-live", memberId: "u13", submissionId: "s-approved", createdAt: serverTimestamp() }));
});

// ---------------- filings: the members' window, before publicAt ----------------

await check(`a member can read a live filing in its members' window (${whenVsSoon()})`, async () => {
  await assertSucceeds(getDoc(doc(member("m1"), "filings/f-members")));
});

await check(`anon cannot read a live filing in its members' window (${whenVsSoon()})`, async () => {
  await assertFails(getDoc(doc(anon(), "filings/f-members")));
});

await check("a signed-in account with no role claim yet gets the members' window too", async () => {
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

// ---------------- after publicAt has passed on the emulator's clock ----------------

const wait = soon.getTime() + 1500 - Date.now();
if (wait > 0) await new Promise((r) => setTimeout(r, wait));

await check(`anon can read the members'-window filing once publicAt has passed (${whenVsSoon()})`, async () => {
  await assertSucceeds(getDoc(doc(anon(), "filings/f-members")));
});

await check(`anon can read the members'-window product once publicAt has passed (${whenVsSoon()})`, async () => {
  await assertSucceeds(getDoc(doc(anon(), "products/p-members")));
});

console.log(`\n${pass} passed, ${fail} failed`);
await testEnv.cleanup();
if (fail > 0) process.exit(1);
