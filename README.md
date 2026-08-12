# Degenerates Inc.

Storefront for a small-run clothing label. Everything prints in limited
quantities and then it's gone; every order ships with a numbered *Certificate of
Degeneracy* that makes the buyer a shareholder on paper.

Built from `degen-inc-mockup.html` — a single-file interface mockup — ported to
Next.js with the visual language kept intact.

## Status

**Front end only.** Every screen is built and routable, but there is no backend
behind any of it: no products, no carts, no accounts, no orders. Forms validate
and then tell you they aren't connected. See [Wiring the backend](#wiring-the-backend).

> **The `/admin` gate is not real.** Submitting the staff sign-in form reveals
> the console to anyone who clicks it. Nothing behind it reads or writes real
> data, and nothing should until Supabase auth plus a staff-role check are in
> place.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
```

```bash
npm run build      # production build
npm start          # serve the build
npm run lint
```

## Routes

| Route      | What it is                                                        |
| ---------- | ----------------------------------------------------------------- |
| `/`        | Storefront: hero, charter memo, Filing 001 grid, collective, open call |
| `/soon`    | "In Production" holding page — where every unbuilt link lands      |
| `/account` | Member record: sign-in, certificate preview, order history         |
| `/admin`   | Back of house: orders, filings, members, submissions               |

## Layout

```
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
    supabase/client.ts      browser client, null until configured
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

Nothing below is built yet. In rough dependency order:

1. **Create a Supabase project**, then `cp .env.example .env.local` and fill in
   the URL and publishable (anon) key. `getSupabase()` returns `null` until both
   are set, so the app keeps running unconfigured.
2. **Schema.** Tables the interface already implies: `products`, `filings`
   (a filing is one drop), `filing_products`, `members`, `certificates`
   (numbered in order, non-transferable, never reused), `orders`, `order_items`,
   `submissions`, and `votes` (one per member per filing).
3. **Row Level Security on every table**, before any real data goes in. Members
   read only their own orders and certificates; staff-only tables check a role
   claim. RLS is the actual security boundary — the anon key is public.
4. **Auth** in `SignInPanel`, replacing the stub submit handler.
5. **A real admin gate.** Server-side session check plus a staff role, so the
   console is never reachable by clicking a button. Today it is.
6. **The open-call form** writes to `submissions` (`OpenCall.tsx`).
7. **Cart and checkout.** The bag counter in the masthead is hardcoded to `0`.

## Credits

Interface and copy: the `degen-inc-mockup.html` prototype. Est. 2026,
Jacksonville NC.
