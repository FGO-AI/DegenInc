import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * OpenNext adapter config.
 *
 * Deliberately bare. No incremental cache override is set yet: every route in
 * this app is statically prerendered and there is no ISR, no `use cache`, and
 * no revalidation, so an R2-backed cache would be infrastructure with nothing
 * to store. Add `r2IncrementalCache` here when the first dynamic/revalidating
 * route lands — it also needs the NEXT_INC_CACHE_R2_BUCKET binding and the
 * WORKER_SELF_REFERENCE service in wrangler.jsonc.
 *
 * See https://opennext.js.org/cloudflare/caching
 */
export default defineCloudflareConfig();
