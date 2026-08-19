import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

/**
 * Server-only handle on D1.
 *
 * `server-only` is the guard rail: importing this from a Client Component is
 * a build error rather than a runtime surprise. That matters more here than it
 * did under Supabase — there is no anon key and no public endpoint, so the
 * browser has no legitimate path to the database at all.
 *
 * The binding is per-request, so this cannot be a module-level singleton.
 * getCloudflareContext() resolves it in both `next dev` (via
 * initOpenNextCloudflareForDev in next.config.ts) and the Workers runtime.
 * Do not import `env` from "cloudflare:workers" in Next server code.
 */
export function getDb(): DrizzleD1Database<typeof schema> {
  const { env } = getCloudflareContext();

  if (!env?.DB) {
    throw new Error(
      "D1 binding `DB` is missing. Check d1_databases in wrangler.jsonc, and " +
        "that next.config.ts calls initOpenNextCloudflareForDev() for `next dev`.",
    );
  }

  return drizzle(env.DB, { schema });
}

/** Async variant, for contexts that need the awaited Cloudflare context. */
export async function getDbAsync(): Promise<DrizzleD1Database<typeof schema>> {
  const { env } = await getCloudflareContext({ async: true });

  if (!env?.DB) {
    throw new Error("D1 binding `DB` is missing.");
  }

  return drizzle(env.DB, { schema });
}

export { schema };
export type Db = DrizzleD1Database<typeof schema>;
