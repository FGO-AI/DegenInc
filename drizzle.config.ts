import type { Config } from "drizzle-kit";

/**
 * drizzle-kit only GENERATES migration SQL here; it never connects to D1.
 * Applying is wrangler's job:
 *
 *   npm run db:generate                        # schema.ts -> migrations/*.sql
 *   npm run db:migrate                         # apply to the local D1
 *   npx wrangler d1 migrations apply degen-inc --remote
 *
 * `out` matches migrations_dir in wrangler.jsonc so both tools read the same
 * directory. dialect is "sqlite" because D1 is SQLite.
 */
export default {
  schema: "./src/lib/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
} satisfies Config;
