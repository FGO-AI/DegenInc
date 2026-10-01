# Degenerates Inc.

Storefront for a small-run clothing label. Everything prints in limited
quantities and then it's gone; every order ships with a numbered *Certificate of
Degeneracy* that makes the buyer a shareholder on paper.

Built from `degen-inc-mockup.html` — a single-file interface mockup — ported to
Next.js with the visual language kept intact.

## Status

A Next.js 16 app on **Firebase**: Firestore for data, Firebase Authentication
for sign-in, Cloud Storage for product photos, Cloud Functions for the
catalogue's writes, and App Hosting to serve it. One backend, so native iOS and
Android apps can share it later.

The filing grid, product pages and the bag read live products, stock and
release windows. Members sign in with email and password. The admin console
manages filings, products, variants and photos through Cloud Functions.
Checkout reserves stock in a single transaction. Payments are not built — see
[Still to build](#still-to-build).

## Running it locally

Everything runs against the Firebase **emulators**, under the demo project
`demo-degen-inc`: no Firebase login, and nothing touches a real project.

You need Node 24 and **JDK 21** on `PATH` — the emulators are Java programs
(`winget install Microsoft.OpenJDK.21`, or any JDK 21).

```bash
npm install
npm --prefix functions install

npm run emulators       # terminal 1: Firestore, Auth, Storage, Functions
npm run seed:emulator   # terminal 2: the test catalogue (filings, products, photos)
npm run dev             # terminal 2: http://localhost:3000
```

`next dev` picks up `.env.development`, which points both the browser SDK and
the server's Admin SDK at the emulators. Emulator data does not survive a
restart; run the seed again after each `npm run emulators`.

There are no seeded accounts. Make one at `/account`, then make yourself the
owner:

```bash
node scripts/promote-role.mjs --emulator you@example.com owner
```

and sign in again — a role change signs the account out everywhere, so the new
role arrives with the next sign-in.

```bash
npm run build      # production build
npm start          # serve the build
npm run lint
```

## The backend

### Two locks, and why both

**`firestore.rules` protect the browser and the mobile apps.** Anything a client
reads or writes directly goes through them: product pages' data, a member's own
orders, votes, open-call submissions.

**The Next server is not covered by them.** It reads and writes with the Admin
SDK, which bypasses every rule. So every server data function in
`src/lib/db/` calls a guard from `src/lib/auth/guards.ts` — `getSession()`,
`requireMember()`, `requireStaff()`, `requireOwner()` — before anything else, and
the genuinely public ones say so in a comment, so "no guard" is always a
decision.

**One visibility rule, written twice, on purpose.** Whether a filing or product
can be seen right now — closed always; live once `publicAt` has passed, or
earlier for a signed-in member once `memberAccessAt` has; staff always — is
`isVisible()` in `firestore.rules` for clients, and `isVisible()` in
`src/lib/visibility.ts` for the server. Each carries a comment saying they must
agree. Change one, change the other.

### Collections

| Collection | What | Who writes |
| --- | --- | --- |
| `users/{uid}` | the account's profile; `role` mirrors the claim | `onUserCreate`, `promote-role.mjs` |
| `filings/{id}` | one drop: number, title, status, `memberAccessAt`, `publicAt` | Cloud Functions |
| `state/currentFiling` | which filing is live, if any | `updateFilingStatus` |
| `products/{id}` | a product, carrying its filing's status and times, and its photos | Cloud Functions |
| `variants/{id}` | size, colour, SKU, stock, and the `productId` it belongs to | Cloud Functions, checkout |
| `orders/{id}` | a member's order, its lines inside it | checkout (server) |
| `certificates/{uid}` | one per member, forever | `issueCertificate` |
| `counters/certificates` | the last certificate number | `issueCertificate` |
| `votes/{filingId}_{uid}` | one vote per member per filing | the member, under the rules |
| `submissions/{id}` | open-call entries | anyone, under the rules |
| `filingNumbers`, `slugs`, `skus`, `variantKeys` | one document per unique value | Cloud Functions |

**Products carry their filing's status and times** (`filingStatus`, `publicAt`,
`memberAccessAt`), so a product's visibility needs no second read. The
function that changes a filing's status writes all three onto every product in
the same transaction, every time — a filing and its products never disagree.

**Variants are top-level** because the bag and checkout know a variant by its id
alone. The rules read the parent product through `resource.data.productId`, so a
client query for variants must filter on `productId`.

**Uniqueness is a lookup document per value** — a filing number, a slug, a SKU, a
product's size and colour — created with `create()` in the same transaction as
the record that owns it. `create()` fails if the document exists, so Firestore
itself refuses a duplicate.

Composite indexes are in `firestore.indexes.json`; only a member's order history
needs one.

### Sign-in

Email and password with **Firebase Authentication**. The browser signs in with
the Firebase JS SDK, then posts the ID token to `/api/session`, which turns it
into an httpOnly, secure, `sameSite=lax` session cookie (`__session`, five days).
The server reads that cookie in `getSession()` with
`verifySessionCookie(cookie, true)`, which also checks for revocation. Signing
out clears the cookie and revokes the account's tokens.

The browser SDK stays signed in too — the admin console calls Cloud Functions
with it — and `SessionSync` keeps the two halves from disagreeing: a page that
finds one signed in without the other signs both out.

**Roles are custom claims.** No claim means member; `staff` and `owner` are set
only by `scripts/promote-role.mjs`, through the Admin SDK. The rules, the server
guards and the function guards all read the same claim.

### Cloud Functions (`functions/`)

A package of its own, with its own `package.json`, build and dependencies.

- **Callables, used by the admin console:** `createFiling`,
  `updateFilingStatus` (owner only), `createProduct`, `createVariant`,
  `uploadProductImage`. Each checks the caller's claim itself, against a token
  it re-verifies for revocation, so a demoted staff member is refused at once.
- **`onUserCreate`** writes the new account's `users/{uid}` document.
- **`issueCertificate`** issues a member's certificate for a *paid* order, with
  the next number from the counter in the same transaction. Not deployed and not
  called yet: it belongs to marking an order paid, which waits for Stripe.

### Checkout

`src/lib/db/checkout.ts`, one Firestore transaction. It reads every variant in
the order and each one's product, checks — on those freshly read values — that
every line is live, visible to this buyer and in stock, and only then writes the
decrements and the order together. Two buyers racing for the last one cannot
both commit: Firestore runs one of them again, and that run reads stock 0.

### Images

Photos live in Cloud Storage at `products/<productId>/<uuid>.<ext>` and are
served by `/images/...`, which checks that the product lists the image and is
visible to the viewer before streaming it. Publicly visible images are cached
for a year; anything else is `private, no-store`. `storage.rules` deny every
direct client read and write — the mobile apps will need a read rule there.

### Nothing that reads a request may be prerendered

Next renders every route at build time to decide whether it can be static. That
build has no session and no emulator, so anything touching either opts out with
`connection()` from `next/server`, which resolves only at request time.
`getSession()` and every query in `src/lib/db/queries.ts` call it first. `/` and
`/admin` should both show as `ƒ (Dynamic)` in the build output; if `/` ever
shows `○ (Static)`, the storefront has been frozen at build time.

## Tests

```bash
npm run test:emulators   # all three suites, under one emulator session
npm run test:rules       # firestore.rules against the Firestore emulator
npm run test:functions   # the Cloud Functions, end to end
npm run test:app         # builds and starts the app, then drives it over HTTP
```

They need JDK 21 and run against `demo-degen-inc`. Nothing is mocked: the rules
tests use the emulator's own clock for the release windows, and the concurrency
tests fire real overlapping requests.

## Deploying

Firebase project on the **Blaze** plan (App Hosting, Cloud Functions and Cloud
Storage all need it). Set a budget alert in Cloud Billing; `apphosting.yaml`
already caps the site at two instances.

1. In the Firebase console, create **Firestore** (Native mode), turn on
   **Authentication** with Email/Password, and create **Storage**.
2. `npx firebase login`, and point the CLI at the project:
   `npx firebase use --add`.
3. Deploy the rules, indexes and functions:
   `npx firebase deploy --only firestore,storage,functions`.
4. **App Hosting:** create a backend in the console, connect the GitHub repo,
   and choose the live branch. Every push to that branch rebuilds and redeploys.
   App Hosting supplies the app's config itself (`FIREBASE_CONFIG`,
   `FIREBASE_WEBAPP_CONFIG`; see `apphosting.yaml`) — no keys to paste.
5. Sign up on the live site, then make yourself the owner with
   `node scripts/promote-role.mjs you@example.com owner`, using Application
   Default Credentials (`gcloud auth application-default login`) and
   `GOOGLE_CLOUD_PROJECT` set to the project id.

Secrets, when there are any, go in Cloud Secret Manager
(`firebase apphosting:secrets:set NAME`) and are referenced by name in
`apphosting.yaml` — never written into a file.

The GitHub Pages workflow (`.github/workflows/pages.yml`) still publishes a
static, look-at-it preview of the storefront design; it has no backend.

## Routes

| Route      | What it is                                                     |
| ---------- | -------------------------------------------------------------- |
| `/`        | Storefront: hero, the live filing's grid, gallery, open call   |
| `/product/[slug]` | A product on the live filing                            |
| `/cart`    | The bag, and checkout                                          |
| `/about`   | The charter, as a photocopied internal memo                    |
| `/gallery` | Photographs of the runs — empty until the first filing ships   |
| `/soon`    | "In Production" holding page — where every unbuilt link lands   |
| `/account` | Member record: sign-in, certificate, order history             |
| `/admin`   | Back of house: orders, filings, members, submissions           |

## Layout

```
firestore.rules             who may read and write what, for clients
firestore.indexes.json      composite indexes
storage.rules               deny-all, for now
functions/                  Cloud Functions (own package)
scripts/
  seed-emulator.ts          load the test catalogue into the emulators
  seed/                     the catalogue snapshot and its photos
  promote-role.mjs          give an account a role
src/
  app/
    layout.tsx              fonts, ambient layer, drawer provider
    globals.css             design tokens, reset, distress utilities
    page.tsx                storefront
    product/[slug]/         a product page
    cart/                   the bag and checkout
    account/                member record + SignInPanel
    admin/                  AdminConsole (tabbed panes) and Filings
    api/session/            sign-in and sign-out, server half
    images/[...key]/        product photos, checked per request
    about/  gallery/  soon/
  components/
    chrome/                 site furniture used across routes
      DitherField           1-bit dithered particle background
      SvgFilters            #rough / #grime / #tear filter defs
      Overlays              film grain + scanlines
      Drawer, DrawerProvider, Masthead, CartButton, Ticker, Footer
    store/                  storefront sections
      Hero, FilingGrid, Gallery, OpenCall
      Collective            parked — returns before launch
    ui/                     reusable primitives
      Button, Field, Panel, Certificate, EmptyState, IconButton, Layout
  lib/
    auth/                   guards, the session cookie, browser sign-in, SessionSync
    firebase/               the Admin SDK (server) and the JS SDK (browser)
    db/                     queries and checkout — server-only
    catalogue/              the admin console's Cloud Function calls
    visibility.ts           the server's copy of the visibility rule
    cart/                   the bag, in localStorage
    fonts.ts                next/font declarations
```

## Styling

No CSS framework. The mockup's look *is* the product, so it's ported directly:

- **Design tokens** live in `globals.css` as custom properties — nine greys, four
  type families, one timing value.
- **Component styles** are CSS Modules, colocated with the component.
- **Three global utilities** stay global because any element can take them:
  `eroded` (mask that eats the edges off display type), `rough` (SVG-displaced
  border drawn on a `::before`), and `torn`. Plus `mono` for the small
  uppercase monospace detail.

Fonts (Pirata One, Grenze Gotisch, Inter, Space Mono) are self-hosted through
`next/font` rather than pulled from the Google Fonts CDN — no render-blocking
request, no layout shift, no third party watching your visitors.

### The background

`DitherField` renders a particle flow field into an offscreen canvas at 1/3
resolution, thresholds it to pure black and white through a 4×4 Bayer matrix,
then scales it back up with image smoothing off. The upscale is the whole trick:
it keeps the dither pattern crisp so the result reads as 1-bit print rather than
a blurry gradient. It pauses on tab hide and renders a single static frame under
`prefers-reduced-motion`.

## Still to build

1. **Stripe.** Take payment for an order, mark it paid, and call
   `issueCertificate` when it is. On App Hosting this is the standard Node
   Stripe client.
2. **The open-call form** writes to `submissions` (the rules already accept a
   well-formed public entry), behind bot protection — Firebase App Check is the
   natural fit.
3. **Voting** on approved submissions; the rules already allow a member one vote
   per filing.
4. **The admin console's Orders, Members and Submissions panes**, which are
   placeholders.
5. **Email**, then require verified addresses.
6. **The mobile apps**, starting with a Storage read rule for product photos
   that makes the same visibility decision as the rules.

## Credits

Interface and copy: the `degen-inc-mockup.html` prototype. Est. 2026,
Jacksonville NC.
