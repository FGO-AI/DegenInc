import { getAuth } from "@/lib/auth";

/**
 * Better Auth's HTTP surface: sign-up, sign-in, sign-out, session.
 *
 * Node.js runtime, not edge — the Cloudflare adapter targets Node and the auth
 * library needs APIs the edge runtime restricts. Do not add
 * `export const runtime = "edge"` here.
 *
 * The handler is resolved per request because the auth instance depends on the
 * D1 binding, which does not exist at module load.
 */
async function handler(request: Request): Promise<Response> {
  const auth = await getAuth();
  return auth.handler(request);
}

export const GET = handler;
export const POST = handler;
