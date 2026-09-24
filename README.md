# Degenerates Inc.

Storefront for a small-run clothing label. Everything prints in limited
quantities and then it's gone; every order ships with a numbered *Certificate of
Degeneracy* that makes the buyer a shareholder on paper.

Built from `degen-inc-mockup.html` — a single-file interface mockup — ported to
Next.js with the visual language kept intact.

## Status

Front end complete and routable. The data layer runs on **Cloudflare D1** with
Drizzle, and sessions on **Better Auth** (email + password). The filing grid
reads live products, stock, and status; `/admin` is gated server-side; checkout
reserves stock atomically. Cart UI and payments are not built — see
[Wiring the backend](#wiring-the-backend).

`/admin` is guarded in `src/app/admin/layout.tsx` by `requireStaff()`. Signed
out redirects to `/account`; signed in without the staff role redirects to `/`.
The decision is made on the server before any child renders — it does not hide
the console, it refuses to render it.

## Running it

```bash
npm install
npm run db:migrate   # create the local D1 database
npm run db:seed      # optional: a live Filing 001 with stock
npm run dev          # http://localhost:3000
```

```bash
npm run build      # production build
npm start          # serve the build
npm run lint
```

## Data layer

**Cloudflare D1** (SQLite) via **Drizzle ORM**, bound to the worker as `DB`.

```bash
npm run db:generate       # schema.ts -> migrations/*.sql
npm run db:migrate        # apply to local D1
npm run db:seed           # local fixtures
npm run db:migrate:remote # apply to the real database
```

### There is no Row Level Security, and that changes the architecture

This is the single most important thing to understand before adding a query.

Postgres RLS meant the *database* refused to return rows the caller shouldn't
see. A query leaked from the browser was still safe, which is why a public anon
key was tolerable.

**D1 has no equivalent.** It returns whatever it is asked for. So:

- The client never touches the database. There is no public database endpoint
  and no public credential, because none exists to leak.
- Every read and write goes through `src/lib/db/queries.ts`, which is
  `server-only` — importing it from a Client Component is a build error.
- Authorization is application code that you can forget to write. Every
  function handling member or staff data calls a guard first; the genuinely
  public ones say so in a comment, so "no guard" is always a decision.

### D1 constraints worth knowing before you write a query

- **No interactive transactions.** `db.transaction(async tx => …)` throws.
  Multi-statement writes use `db.batch([...])`, which is atomic but cannot
  branch — you cannot read a value mid-batch and decide what to do next.
- **Use constraints to fail a batch, not conditions.** A conditional
  `UPDATE … WHERE stock >= ?` that matches nothing does *not* error; it changes
  zero rows and the batch commits, and you have sold a shirt you do not have.
  So `variants.stock` carries `CHECK (stock >= 0)` and checkout decrements
  unconditionally. Going negative violates the constraint, the statement
  errors, and D1 rolls the whole batch back.
- **No sequences.** Certificate numbers come from the `counters` table,
  incremented with `UPDATE … SET value = value + 1 … RETURNING value` inside
  the same batch as the insert that consumes it. Numbers are never reused.
- **No Postgres types.** No `uuid`, `timestamptz`, or `jsonb`. Ids are `text`
  from `crypto.randomUUID()`, times are integer Unix milliseconds, addresses
  are `text` holding JSON, money is integer cents.
- **Read replicas can serve stale reads.** Fine for showing stock on a product
  page. Not fine for the checkout write path, which must rely on the constraint
  rather than a number it read a moment ago.

## Cloudflare deployment

Hosted on **Cloudflare Workers** via the [OpenNext](https://opennext.js.org/cloudflare)
adapter.

```bash
npm run build:cf    # typegen + adapter build -> .open-next/worker.js
npm run preview     # build:cf + serve through the real Workers runtime (:8787)
npm run deploy      # build:cf + push to Workers
npm run cf-typegen  # regenerate cloudflare-env.d.ts by hand
```

`npm run dev` runs the plain Next dev server and is faster for day-to-day work.
`next.config.ts` calls `initOpenNextCloudflareForDev()` so `env.DB` resolves
there too — without it every query fails with an opaque error. In server code,
reach bindings with `getCloudflareContext()`; never import `env` from
`cloudflare:workers`.

### `cloudflare-env.d.ts` is generated, not committed

`wrangler types` writes `cloudflare-env.d.ts`, which supplies both the
`CloudflareEnv` interface (with `DB: D1Database`) and the `D1Database` type
itself. Without it the build dies at the TypeScript step with `Cannot find name
'D1Database'` and `Property 'DB' does not exist on type 'CloudflareEnv'`.

It stays gitignored: ~15k lines that go stale the moment `wrangler.jsonc`
changes. Instead it is generated on every build.

- `prebuild` runs `cf-typegen`, and npm runs `prebuild` automatically before
  `build` — so even a plain `npm run build` generates types first.
- `build:cf` runs `cf-typegen` explicitly, and `preview` and `deploy` both
  route through it. No path reaches the compiler without types.

`wrangler types` reads local config only. **It needs no Cloudflare login and no
real `database_id`**, so it is safe in CI.

If a build ever fails with those errors, run typegen — do not un-ignore the
file.

### Nothing that reads a request may be prerendered

Next renders every route at build time to decide whether it can be static.
That build has no D1 binding and no runtime secrets, so anything touching the
session or the database must opt out — with `connection()` from `next/server`,
which resolves only at request time and stops prerendering there.

- `getSession()` calls it before `getAuth()`. Otherwise `getAuth()` throws on
  the missing `BETTER_AUTH_SECRET` during the build, before `headers()` can
  signal that the route is dynamic — failing the build on a secret that is,
  correctly, runtime-only.
- `getLiveFiling()` calls it before reading D1. Otherwise the storefront is
  prerendered with no binding, `getLiveFilingSafe()` swallows the error, and
  the "awaiting asset" placeholders are baked into a static page that serves
  forever no matter what the database holds.

`/` and `/admin` should both show as `ƒ (Dynamic)` in the build output. If `/`
ever shows `○ (Static)`, the storefront has been frozen at build time.

Note `export const dynamic` is not the tool here: it is absent from the Next
16.3 route segment config options and is removed outright under Cache
Components.

### Workers Builds

| Setting | Value |
| --- | --- |
| Build command | `npm run build:cf` |
| Deploy command | `npx wrangler deploy` |

The build command **cannot** be `npm run build`. Plain `next build` produces
`.next/`, not `.open-next/worker.js`, which is the entry `wrangler.jsonc`
points at — the deploy would fail on a missing entrypoint. Only
`opennextjs-cloudflare build` emits the worker.

Build-time variables (`NEXT_PUBLIC_*`) go in Workers Builds → Settings →
Variables. Runtime secrets do **not**; they belong in Settings → Variables and
Secrets, or `wrangler secret put`.

### Configuration

- `wrangler.jsonc` — worker name, entry, assets, and the `DB` binding.
  `compatibility_date` tracks the workerd bundled with wrangler; a date newer
  than the installed runtime is rejected, so bump both together. `nodejs_compat`
  is mandatory.
  **`database_id` is a placeholder** until someone with a Cloudflare login runs
  `npx wrangler d1 create degen-inc` and pastes the real id. Local development
  ignores it; every remote command needs it.
- `PRODUCT_IMAGES` — the R2 bucket behind `/images/<key>`. **The bucket name
  `degen-inc-product-images` is unconfirmed**: nobody has created it yet. Run
  `npx wrangler r2 bucket create degen-inc-product-images` with a Cloudflare
  login, or change `bucket_name` to match whatever you do create. Local
  development simulates the bucket on disk; `deploy` needs the real one.
  Uploads are capped at 8MB by the action and by `serverActions.bodySizeLimit`
  in `next.config.ts`, which has to stay a little above that.
- `open-next.config.ts` — deliberately bare.

### Environment variables

| | Where | Why |
| --- | --- | --- |
| `NEXT_PUBLIC_*` | **build** environment (`.env.local`, or Workers Builds variables) | Inlined into the client bundle at build time. `wrangler secret put` does nothing for these — the bundle is already compiled. |
| everything secret | `.dev.vars` locally, `wrangler secret put` in prod | Read per request, never inlined. |

`.dev.vars` is gitignored; `.dev.vars.example` documents the keys. The database
needs no credential at all — it is a binding, not a connection string.

### Not configured yet

- **Cloudflare Images** for `next/image`. Deliberately skipped: product images
  are plain `<img>` served straight from R2, and there are zero `next/image`
  usages. Configure the `images` binding *or* set `images.unoptimized` before
  adding the first one.
- **Turnstile** on the open call form — required before `submissions` accepts
  public writes.
- **Stripe.** On Workers the default Node crypto path throws: initialize with
  `Stripe.createFetchHttpClient()`, verify webhooks with
  `constructEventAsync(body, sig, secret, undefined, webCrypto)` where
  `webCrypto = Stripe.createSubtleCryptoProvider()`, and read the raw body
  exactly once with `await request.text()`.
- **Workers Builds** against the GitHub repo, and the custom domain.

### Constraints

- **Node.js runtime only.** Never add `export const runtime = "edge"`.
- **No direct Postgres driver** (`pg`, `postgres.js`, Drizzle over TCP).
  Workers cannot open raw TCP without Hyperdrive. D1 is a binding, so this
  does not arise — but it is why the data layer is D1 rather than a hosted
  Postgres.
- **Bundle budget**: 3 MiB gzipped on the free plan. Check with
  `npx wrangler deploy --dry-run --outdir=.wrangler/dryrun`.

## Routes

| Route      | What it is                                                     |
| ---------- | -------------------------------------------------------------- |
| `/`        | Storefront: hero, Filing 001 grid, gallery, open call          |
| `/about`   | The charter, as a photocopied internal memo                    |
| `/gallery` | Photographs of the runs — empty until the first filing ships   |
| `/soon`    | "In Production" holding page — where every unbuilt link lands   |
| `/account` | Member record: sign-in, certificate preview, order history     |
| `/admin`   | Back of house: orders, filings, members, submissions           |

## Layout

```
migrations/                 generated SQL, applied by wrangler
scripts/seed.sql            local fixtures
src/
  app/
    layout.tsx              fonts, ambient layer, drawer provider
    globals.css             design tokens, reset, distress utilities
    page.tsx                storefront
    about/                  the charter + Memo
    gallery/                photo grid, empty for now
    soon/                   holding page
    account/                member record + SignInPanel
    admin/                  AdminConsole (gate + tabbed panes)
  components/
    chrome/                 site furniture used across routes
      DitherField           1-bit dithered particle background
      SvgFilters            #rough / #grime / #tear filter defs
      Overlays              film grain + scanlines
      Drawer, DrawerProvider, Masthead, Ticker, Footer
    store/                  storefront sections
      Hero, FilingGrid, Gallery, OpenCall
      Collective            parked — returns before launch
    ui/                     reusable primitives
      Button, Field, Panel, Certificate, EmptyState, IconButton, Layout
  lib/
    fonts.ts                next/font declarations
    db/
      schema.ts             Drizzle table definitions
      index.ts              server-only D1 handle
      queries.ts            server-only data access layer
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

## Wiring the backend

Done:

1. **D1 + Drizzle.** Schema in `src/lib/db/schema.ts`, migrations in
   `migrations/`, server-only access in `src/lib/db/queries.ts`. The filing grid
   reads it.

2. **Auth.** Better Auth 1.7.1 with the Drizzle D1 adapter, email + password,
   sessions in D1. `src/lib/auth/index.ts` builds it as an async singleton —
   the binding only exists per request, so it cannot be constructed at module
   load. That shape is also why `better-auth generate` cannot read it; run
   `node scripts/auth-schema.mjs` after upgrading to diff the expected tables
   against `schema.ts`.
3. **The guard module.** `getSession()` / `requireMember()` / `requireStaff()`
   in `src/lib/auth/guards.ts`, called first by every non-public data function.
4. **The admin gate.** `requireStaff()` in the `/admin` layout, redirecting on
   the server.
5. **Stock-safe checkout.** `src/lib/db/checkout.ts` reserves stock in one
   `db.batch()` and relies on `variants_stock_non_negative`. Verified with
   `scripts/concurrent-checkout.mjs`: five simultaneous buyers against a
   stock-1 variant produce exactly one order.

Still to build, in dependency order:

6. **Cart UI.** The bag counter in the masthead is hardcoded to `0`; the
   checkout API exists but nothing in the interface calls it.
7. **The open-call form** writes to `submissions`, behind Turnstile.
8. **Stripe**, against the reserved order.
9. **Email**, then flip `requireEmailVerification` on.

## Credits

Interface and copy: the `degen-inc-mockup.html` prototype. Est. 2026,
Jacksonville NC.
