import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";

/**
 * Built through a factory so the return type stays the precise inferred
 * `Auth<typeof options>`. Typing the cache as `ReturnType<typeof betterAuth>`
 * widens it to `Auth<BetterAuthOptions>`, which the real instance is not
 * assignable to — `secret` narrows from `string | undefined` to `string`.
 */
function createAuth(db: D1Database, secret: string) {
  return betterAuth({
    secret,
    baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",

    database: drizzleAdapter(drizzle(db, { schema }), {
      provider: "sqlite",
      // Passed explicitly so the adapter resolves models by these keys rather
      // than guessing from the drizzle instance.
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),

    emailAndPassword: {
      enabled: true,
      // No mail provider wired up yet, so requiring verification would lock
      // every new account out. Turn this on with the transactional email.
      requireEmailVerification: false,
    },

    user: {
      additionalFields: {
        /**
         * Mirrored into the session so guards do not need a second query.
         *
         * `input: false` is the load-bearing part: it stops role being
         * accepted from sign-up or update payloads. Without it a visitor could
         * register themselves as staff.
         */
        role: {
          type: "string",
          required: false,
          defaultValue: "member",
          input: false,
        },
      },
    },

    // Must be last. Lets Better Auth set cookies through the Next.js API.
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;

/**
 * Better Auth cannot be built at module load.
 *
 * The D1 binding only exists inside a request, so `betterAuth({...})` at the
 * top level would capture an undefined database. Instead the instance is
 * created on first use and cached for the lifetime of the isolate — one
 * construction per worker, not one per request.
 *
 * This shape is also why `better-auth generate` cannot read this file: the CLI
 * expects a plain exported object. Schema changes go through
 * scripts/auth-schema.mjs instead, and are mirrored by hand into
 * src/lib/db/schema.ts.
 */
let cached: Auth | null = null;

export async function getAuth(): Promise<Auth> {
  if (cached) return cached;

  const { env } = await getCloudflareContext({ async: true });

  if (!env?.DB) {
    throw new Error(
      "D1 binding `DB` is missing. Auth cannot initialise. Check " +
        "d1_databases in wrangler.jsonc and initOpenNextCloudflareForDev() in " +
        "next.config.ts.",
    );
  }

  const secret =
    (env as unknown as Record<string, string | undefined>).BETTER_AUTH_SECRET ??
    process.env.BETTER_AUTH_SECRET;

  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. Add it to .dev.vars locally, or with " +
        "`wrangler secret put BETTER_AUTH_SECRET` in production.",
    );
  }

  const auth = createAuth(env.DB, secret);
  cached = auth;
  return auth;
}
