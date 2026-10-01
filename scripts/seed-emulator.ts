// Load the test catalogue into the Firestore and Storage emulators:
//
//   firebase emulators:start --project demo-degen-inc     (one terminal)
//   npm run seed:emulator                                 (another)
//
// so local development starts with real-looking data: the filings, products,
// variants, product photos and open-call submission from the old local
// development database, snapshotted into scripts/seed/ (catalogue.json, and the
// photos in images/). No orders and no accounts: make those by signing up in
// the app, and promote yourself with scripts/promote-role.mjs.
//
// EMULATORS ONLY, always. It points the Admin SDK at the emulators on the ports
// in firebase.json unless FIRESTORE_EMULATOR_HOST and
// FIREBASE_STORAGE_EMULATOR_HOST already name others (as emulators:exec sets
// them). With those set, the Admin SDK cannot reach a real project at all, so
// there is no way to point this one at production.
//
// It writes the current schema, the way the Cloud Functions would: random
// document ids, a lookup for every unique value (filingNumbers, slugs, skus,
// variantKeys), each product carrying its filing's status and times, variants
// top-level with a productId, images under products/<productId>/<uuid>.jpg.
// It first deletes the catalogue it would write — filings, products, variants,
// the lookups, submissions, the live-filing pointer and the product photos —
// so running it twice leaves one catalogue, not two. Accounts and orders are
// left alone.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

type Catalogue = {
  filings: {
    key: string;
    number: number;
    title: string;
    status: "draft" | "scheduled" | "live" | "closed";
    memberAccessAt: string | null;
    publicAt: string | null;
    createdAt: string;
  }[];
  products: {
    key: string;
    filing: string;
    slug: string;
    name: string;
    kind: string;
    description: string | null;
    priceCents: number;
    position: number;
    createdAt: string;
    images: { file: string; alt: string | null; position: number }[];
  }[];
  variants: { product: string; size: string; color: string; sku: string; stock: number; createdAt: string }[];
  submissions: {
    name: string;
    contact: string;
    workUrl: string;
    note: string | null;
    status: string;
    createdAt: string;
  }[];
};

// ||=, not ??=: an empty value would leave the Admin SDK talking to production.
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= "127.0.0.1:9199";

const project = process.env.GCLOUD_PROJECT ?? "demo-degen-inc";
initializeApp({ projectId: project, storageBucket: `${project}.appspot.com` });
const db = getFirestore();
const bucket = getStorage().bucket();

const dir = new URL("./seed/", import.meta.url);
const catalogue: Catalogue = JSON.parse(readFileSync(new URL("catalogue.json", dir), "utf8"));
const at = (iso: string) => Timestamp.fromDate(new Date(iso));

// ---------------- clear what this writes ----------------

for (const name of ["filings", "filingNumbers", "products", "slugs", "variants", "skus", "variantKeys", "submissions"]) {
  await db.recursiveDelete(db.collection(name));
}
await db.doc("state/currentFiling").delete();
await bucket.deleteFiles({ prefix: "products/" });

// ---------------- write it ----------------

/** The same encoding functions/src/validation.ts uses to build a lookup id. */
const docIdFrom = (...parts: string[]) => parts.map(encodeURIComponent).join("_");

// Every filing needs both times now, and a live one without them would be
// invisible to everyone but staff. The snapshot's later filings never had
// them, so they get two moments already past: members two days ago, everyone
// yesterday.
const DAY = 24 * 60 * 60 * 1000;
const backfilled: number[] = [];

const filingIds = new Map<string, string>();
const filingTimes = new Map<string, { status: string; memberAccessAt: Timestamp; publicAt: Timestamp }>();
for (const f of catalogue.filings) {
  const ref = db.collection("filings").doc();
  filingIds.set(f.key, ref.id);
  if (!f.memberAccessAt || !f.publicAt) backfilled.push(f.number);
  const memberAccessAt = f.memberAccessAt ? at(f.memberAccessAt) : Timestamp.fromMillis(Date.now() - 2 * DAY);
  const publicAt = f.publicAt ? at(f.publicAt) : Timestamp.fromMillis(Date.now() - DAY);
  filingTimes.set(f.key, { status: f.status, memberAccessAt, publicAt });

  const batch = db.batch();
  batch.create(ref, {
    number: f.number,
    title: f.title,
    status: f.status,
    memberAccessAt,
    publicAt,
    createdAt: at(f.createdAt),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.create(db.doc(`filingNumbers/${String(f.number).padStart(3, "0")}`), { filingId: ref.id });
  if (f.status === "live") batch.set(db.doc("state/currentFiling"), { filingId: ref.id });
  await batch.commit();
}

const productIds = new Map<string, string>();
let imagesWritten = 0;
for (const p of catalogue.products) {
  const ref = db.collection("products").doc();
  productIds.set(p.key, ref.id);
  const filing = filingTimes.get(p.filing)!;

  const images = [];
  for (const image of p.images) {
    const path = `products/${ref.id}/${randomUUID()}.jpg`;
    await bucket.file(path).save(readFileSync(new URL(`images/${image.file}`, dir)), {
      contentType: "image/jpeg",
      resumable: false,
    });
    images.push({ id: randomUUID(), path, alt: image.alt, position: image.position });
    imagesWritten++;
  }

  const batch = db.batch();
  batch.create(ref, {
    filingId: filingIds.get(p.filing),
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    description: p.description,
    priceCents: p.priceCents,
    position: p.position,
    filingStatus: filing.status,
    memberAccessAt: filing.memberAccessAt,
    publicAt: filing.publicAt,
    images,
    createdAt: at(p.createdAt),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.create(db.doc(`slugs/${p.slug}`), { productId: ref.id });
  await batch.commit();
}

for (const v of catalogue.variants) {
  const ref = db.collection("variants").doc();
  const productId = productIds.get(v.product)!;
  const batch = db.batch();
  batch.create(ref, {
    productId,
    size: v.size,
    color: v.color,
    sku: v.sku,
    stock: v.stock,
    createdAt: at(v.createdAt),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.create(db.doc(`skus/${docIdFrom(v.sku)}`), { productId, variantId: ref.id });
  batch.create(db.doc(`variantKeys/${docIdFrom(productId, v.size, v.color)}`), { variantId: ref.id });
  await batch.commit();
}

for (const s of catalogue.submissions) {
  await db.collection("submissions").doc().create({ ...s, createdAt: at(s.createdAt) });
}

// ---------------- check it ----------------

const counted = async (name: string) => (await db.collection(name).count().get()).data().count;
const [storedImages] = await bucket.getFiles({ prefix: "products/" });
const rows: [string, number, number][] = [
  ["filings", catalogue.filings.length, await counted("filings")],
  ["products", catalogue.products.length, await counted("products")],
  ["variants", catalogue.variants.length, await counted("variants")],
  ["images", catalogue.products.reduce((n, p) => n + p.images.length, 0), storedImages.length],
  ["submissions", catalogue.submissions.length, await counted("submissions")],
  ["filingNumbers", catalogue.filings.length, await counted("filingNumbers")],
  ["slugs", catalogue.products.length, await counted("slugs")],
  ["skus", catalogue.variants.length, await counted("skus")],
  ["variantKeys", catalogue.variants.length, await counted("variantKeys")],
];

console.log(`Seeded ${project}'s emulators (${imagesWritten} photos uploaded):\n`);
console.log("  in the snapshot  in the emulator");
for (const [name, expected, actual] of rows) {
  console.log(`  ${String(expected).padStart(15)}  ${String(actual).padStart(15)}  ${name}${expected === actual ? "" : "   <-- MISMATCH"}`);
}
if (backfilled.length) {
  console.log(`\nFilings ${backfilled.map((n) => String(n).padStart(3, "0")).join(", ")} had no times; given members two days ago, public yesterday.`);
}

if (rows.some(([, expected, actual]) => expected !== actual)) process.exit(1);
