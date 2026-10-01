/**
 * Proves a stock-1 variant cannot be bought twice, against a running app.
 *
 * Fires N checkouts at the same variant simultaneously and asserts that
 * exactly one commits. The rest must come back out_of_stock: the checkout
 * transaction re-reads the stock each time Firestore runs it again, so none
 * can succeed against a stale read. app.test.mjs proves the same thing against
 * the emulators; this is for poking a running dev server by hand.
 *
 * Usage:  node scripts/concurrent-checkout.mjs <cookieHeader> <variantId> [n]
 *         (cookieHeader is "__session=..." from a signed-in browser)
 */
const [, , cookie, variantId, nRaw = "2"] = process.argv;
const n = Number(nRaw);
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

if (!cookie || !variantId) {
  console.error("Usage: node scripts/concurrent-checkout.mjs <cookieHeader> <variantId> [n]");
  process.exit(1);
}

const attempt = (i) =>
  fetch(`${BASE}/api/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ variantId, quantity: 1 }),
  })
    .then(async (r) => ({ i, status: r.status, body: await r.json() }))
    .catch((e) => ({ i, status: 0, body: { error: String(e) } }));

// Launched together, resolved together — no awaiting in between.
const results = await Promise.all(Array.from({ length: n }, (_, i) => attempt(i)));

for (const r of results) {
  console.log(`  attempt ${r.i}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
}

const ok = results.filter((r) => r.status === 200).length;
const conflict = results.filter((r) => r.status === 409).length;

console.log(`\n  succeeded: ${ok}   out_of_stock: ${conflict}   of ${n}`);
console.log(ok === 1 ? "  PASS — exactly one sale" : `  FAIL — ${ok} sales`);
// Set the code rather than calling process.exit(), which tears down
// libuv handles mid-flight and trips an assertion on Windows.
process.exitCode = ok === 1 ? 0 : 1;
