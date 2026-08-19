import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
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
