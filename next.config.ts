import type { NextConfig } from "next";

/**
 * Static preview build (PREVIEW=1), used by .github/workflows/pages.yml.
 *
 * GitHub Pages serves files, not a Node runtime, so this mode drops the whole
 * server half of the app: no D1, no Better Auth, no checkout. What survives is
 * the storefront design, which is the point — it is a link to send someone so
 * they can look at it.
 *
 * getLiveFilingSafe() already returns null when there is no D1 binding and the
 * grid falls back to its "awaiting asset" slots, so the prerender needs no
 * database. scripts/preview-export.mjs stages away the routes that genuinely
 * cannot be exported (/api, /account, /admin) before calling next build.
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

const nextConfig: NextConfig = {
  ...preview,
};

export default nextConfig;

// `next dev` runs in plain Node with no Workers runtime, so bindings like
// env.DB would be undefined and every query would fail with an opaque error.
// This starts a miniflare instance alongside the dev server and makes
// getCloudflareContext() resolve the same bindings dev and prod.
//
// Dev only — it is a no-op in the production build.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
void initOpenNextCloudflareForDev();
