/**
 * Build the static GitHub Pages preview.
 *
 *   npm run preview:pages
 *
 * `output: "export"` refuses to build a route that needs a request: a Better
 * Auth catch-all handler, a checkout POST, a page that reads the session, a
 * layout that redirects. Next has no "exclude this route from the export"
 * switch, so the only way through is to take those routes out of src/app for
 * the duration of the build and put them back afterwards.
 *
 * They are copied aside, not deleted, and the finally block puts them back even
 * when the build throws. If the process is killed hard enough to skip that
 * (SIGKILL, a pulled plug), the copies are still in .preview-staged/ and
 * `git checkout -- src/app` also brings them back, since they are tracked.
 *
 * Copy-then-remove rather than rename: on Windows, renaming a directory that
 * `next dev` is watching fails with EPERM, and this has to work on the machine
 * it is run from as well as in CI.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = join(root, ".preview-staged");

/** Routes that cannot be statically exported, and why. */
const EXCLUDED = [
  ["src/app/api", "auth, checkout and cart-detail handlers; all need a request"],
  ["src/app/account", "reads the session via headers(), so it is always dynamic"],
  ["src/app/admin", "requireStaff() redirects in the layout"],
  ["src/app/images", "streams from the R2 binding; there is no bucket on Pages"],
  ["src/app/cart", "reads the session and hands out a Server Action"],
  ["src/app/product", "a page per live product, read from D1 at request time"],
];

const moved = [];

function stage() {
  rmSync(STAGE, { recursive: true, force: true });
  for (const [rel, why] of EXCLUDED) {
    const from = join(root, rel);
    if (!existsSync(from)) continue;
    const to = join(STAGE, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
    moved.push([from, to]);
    console.log(`  staged away  ${rel}  - ${why}`);
  }
}

function restore() {
  for (const [from, to] of moved.reverse()) {
    if (!existsSync(to)) continue;
    mkdirSync(dirname(from), { recursive: true });
    cpSync(to, from, { recursive: true });
    console.log(`  restored     ${from.slice(root.length + 1)}`);
  }
  rmSync(STAGE, { recursive: true, force: true });
}

// A signal still runs this; SIGKILL does not, which is what the note above is for.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    restore();
    process.exit(1);
  });
}

console.log("Staging routes that need a server:");
stage();

// tsconfig.json includes .next/dev/types, and `next build` type-checks it. That
// directory is written by `next dev` and its validator imports every route that
// existed when dev last ran — including the ones just staged away — so after
// any local `npm run dev` the export failed on "Cannot find module
// src/app/admin/page.js". It is generated output; the next `next dev` rewrites
// it. (CI never has it: the workflow builds from a clean checkout.)
rmSync(join(root, ".next/dev/types"), { recursive: true, force: true });

try {
  console.log("\nBuilding static export...\n");
  // Next's bin is a plain JS file, so run it under this same node rather than
  // through npx: no shell, so nothing depends on how arguments are quoted, and
  // it behaves identically on Windows and Linux.
  execFileSync(
    process.execPath,
    [join(root, "node_modules/next/dist/bin/next"), "build"],
    { cwd: root, stdio: "inherit", env: { ...process.env, PREVIEW: "1" } },
  );
} finally {
  console.log("\nRestoring routes:");
  restore();
}

const out = join(root, "out");

// Pages runs Jekyll over the artifact unless told not to, and Jekyll drops
// every directory whose name starts with an underscore, which is all of Next's
// JS and CSS in _next/. Without this the site loads as bare unstyled HTML.
writeFileSync(join(out, ".nojekyll"), "");
console.log(`\nWrote ${join("out", ".nojekyll")}`);

/**
 * Next 16 writes a route's prefetch payload to `<route>/__next.<seg>/__PAGE__.txt`
 * (a directory) while the router requests `<route>/__next.<seg>.__PAGE__.txt`,
 * with a dot where the separator is. Against a server that difference never
 * surfaces. On Pages the prefetch 404s, so every link falls back to a full
 * document load and the background canvas re-seeds on each navigation.
 *
 * Writing the flat name beside the nested one answers the request without
 * altering anything the export already produced. Remove once the paths agree.
 */
function mirrorPrefetchPayloads(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    if (entry.name.startsWith("__next.")) {
      const nested = join(child, "__PAGE__.txt");
      if (existsSync(nested)) {
        copyFileSync(nested, join(dir, `${entry.name}.__PAGE__.txt`));
        n++;
      }
    } else if (entry.name !== "_next") {
      n += mirrorPrefetchPayloads(child);
    }
  }
  return n;
}

console.log(`Mirrored ${mirrorPrefetchPayloads(out)} prefetch payloads to flat names`);
console.log("Static preview is in out/");

// This build wrote .next/types with the staged routes missing, so the route
// union there no longer mentions /admin or /account. A plain `npx tsc --noEmit`
// afterwards fails on that stale file, which looks like a real type error and
// is not one. Any normal `next dev` or `next build` rewrites it.
console.log(
  "\nNote: .next/types now reflects the reduced route set. Run `npm run build`" +
    "\n(or `npm run dev`) before `npx tsc --noEmit`, or it will fail on stale types.",
);
