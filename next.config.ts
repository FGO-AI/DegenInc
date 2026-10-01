import type { NextConfig } from "next";

/**
 * Static preview build (PREVIEW=1), used by .github/workflows/pages.yml.
 *
 * GitHub Pages serves files, not a Node runtime, so this mode drops the whole
 * server half of the app: no database, no sign-in, no checkout. What survives
 * is the storefront design, which is the point — it is a link to send someone
 * so they can look at it.
 *
 * getLiveFilingSafe() returns null when there is no Firestore to read, and the
 * grid falls back to its "awaiting asset" slots, so the prerender needs no
 * database. scripts/preview-export.mjs stages away the routes that genuinely
 * cannot be exported (/api, /account, /admin, ...) before calling next build.
 *
 * Pages serves a project site from /<repo>, so every asset and link needs that
 * prefix or the page loads as unstyled HTML. Derived from GITHUB_REPOSITORY so
 * a fork publishes under its own name; PREVIEW_BASE_PATH overrides it, and ""
 * is the correct value for a user/org site or a custom domain.
 */
const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
const basePath = process.env.PREVIEW_BASE_PATH ?? (repo ? `/${repo}` : "");

const preview: NextConfig =
  process.env.PREVIEW === "1"
    ? {
        output: "export",
        basePath,
        assetPrefix: basePath || undefined,
        // next/image needs a server to optimise; export has none.
        images: { unoptimized: true },
        // Emit about/index.html rather than about.html, so the Pages URL
        // /DegenInc/about resolves without a redirect.
        trailingSlash: true,
      }
    : {};

/**
 * The browser's Firebase web-app config, inlined at build time.
 *
 * src/lib/firebase/client.ts reads NEXT_PUBLIC_FIREBASE_CONFIG. Locally,
 * .env.development sets it to the emulator's demo project. On App Hosting
 * nothing sets it by hand: App Hosting puts the backend's web-app config in
 * FIREBASE_WEBAPP_CONFIG during the build, and this hands it over. Set
 * NEXT_PUBLIC_FIREBASE_CONFIG yourself and that wins.
 */
const webAppConfig =
  !process.env.NEXT_PUBLIC_FIREBASE_CONFIG && process.env.FIREBASE_WEBAPP_CONFIG
    ? { NEXT_PUBLIC_FIREBASE_CONFIG: process.env.FIREBASE_WEBAPP_CONFIG }
    : undefined;

const nextConfig: NextConfig = {
  ...(webAppConfig ? { env: webAppConfig } : {}),
  ...preview,
};

export default nextConfig;
