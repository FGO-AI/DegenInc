# Degenerates Inc.

Storefront for a small-run clothing label. Everything prints in limited
quantities and then it's gone; every order ships with a numbered *Certificate of
Degeneracy* that makes the buyer a shareholder on paper.

Built from `degen-inc-mockup.html` — a single-file interface mockup — ported to
Next.js with the visual language kept intact.

## Status

Front end complete and routable. The data layer runs on **Cloudflare D1** with
Drizzle: the filing grid reads live products, stock, and status from the
database. Auth, cart, checkout, and payments are not built yet — see
[Wiring the backend](#wiring-the-backend).

> **The `/admin` gate is not real yet.** Submitting the staff sign-in form
> reveals the console to anyone who clicks it. Nothing behind it reads or writes
> real data, and nothing should until the server-side session and staff-role
> check are in place.

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
npm run preview     # build + serve through the real Workers runtime (:8787)
npm run deploy      # build + push to Workers
npm run cf-typegen  # regenerate cloudflare-env.d.ts after editing wrangler.jsonc
```

`npm run dev` runs the plain Next dev server and is faster for day-to-day work.
`next.config.ts` calls `initOpenNextCloudflareForDev()` so `env.DB` resolves
there too — without it every query fails with an opaque error. In server code,
reach bindings with `getCloudflareContext()`; never import `env` from
`cloudflare:workers`.

### Configuration

- `wrangler.jsonc` — worker name, entry, assets, and the `DB` binding.
  `compatibility_date` tracks the workerd bundled with wrangler; a date newer
  than the installed runtime is rejected, so bump both together. `nodejs_compat`
  is mandatory.
  **`database_id` is a placeholder** until someone with a Cloudflare login runs
  `npx wrangler d1 create degen-inc` and pastes the real id. Local development
  ignores it; every remote command needs it.
- `open-next.config.ts` — deliberately bare.

### Environment variables

| | Where | Why |
| --- | --- | --- |
| `NEXT_PUBLIC_*` | **build** environment (`.env.local`, or Workers Builds variables) | Inlined into the client bundle at build time. `wrangler secret put` does nothing for these — the bundle is already compiled. |
| everything secret | `.dev.vars` locally, `wrangler secret put` in prod | Read per request, never inlined. |

`.dev.vars` is gitignored; `.dev.vars.example` documents the keys. The database
needs no credential at all — it is a binding, not a connection string.

### Not configured yet

- **R2** for product images (`product_images.r2_key` already holds object keys).
- **Cloudflare Images** for `next/image`. Zero `next/image` usages today, so
  nothing is broken; configure the `images` binding *or* set
  `images.unoptimized` before adding the first one.
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

| Route      | What it is                                                        |
| ---------- | ----------------------------------------------------------------- |
| `/`        | Storefront: hero, charter memo, Filing 001 grid, collective, open call |
| `/soon`    | "In Production" holding page — where every unbuilt link lands      |
| `/account` | Member record: sign-in, certificate preview, order history         |
| `/admin`   | Back of house: orders, filings, members, submissions               |

## Layout

```
migrations/                 generated SQL, applied by wrangler
scripts/seed.sql            local fixtures
src/
  app/
    layout.tsx              fonts, ambient layer, drawer provider
    globals.css             design tokens, reset, distress utilities
    page.tsx                storefront
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
      Hero, Memo, FilingGrid, Collective, OpenCall
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

Still to build, in dependency order:

2. **Auth** (Better Auth, Drizzle D1 adapter, email + password). Sessions in D1.
   Replaces the stub handler in `SignInPanel`.
3. **The guard module** — `getSession()`, `requireMember()`, `requireStaff()` —
   called first by every non-public data function.
4. **A real admin gate.** Server-side check in the `/admin` layout that
   *redirects*, decided on the server. Today `AdminConsole` just flips a
   `useState`.
5. **The open-call form** writes to `submissions`, behind Turnstile.
6. **Cart and checkout.** The bag counter in the masthead is hardcoded to `0`.
   Checkout decrements stock in a `db.batch()` and leans on
   `variants_stock_non_negative`.

## Credits

Interface and copy: the `degen-inc-mockup.html` prototype. Est. 2026,
Jacksonville NC.
