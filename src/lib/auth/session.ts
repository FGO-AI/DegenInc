import "server-only";

/**
 * The session cookie.
 *
 * `__session` because Firebase's CDN strips every other cookie from requests
 * before they reach the app — this is the one name it passes through.
 *
 * It holds a Firebase session cookie made by createSessionCookie() from a fresh
 * ID token (src/app/api/session/route.ts), and getSession() checks it with
 * verifySessionCookie(cookie, true) on every request. The `true` also checks
 * revocation, which is what makes sign-out and scripts/promote-role.mjs take
 * effect at once rather than when the cookie expires.
 */
export const SESSION_COOKIE = "__session";

/** Five days, in milliseconds. Firebase allows five minutes to two weeks. */
export const SESSION_LIFETIME_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * How recent the sign-in behind an ID token must be for it to become a session.
 * A token can be refreshed for an hour without signing in again; this keeps a
 * stolen one from being turned into a five-day cookie.
 */
export const RECENT_SIGN_IN_S = 5 * 60;

/**
 * Whether a state-changing request comes from this site's own pages.
 *
 * The cookie is sameSite=lax, so a cross-site page cannot make the browser send
 * it with a POST or DELETE in the first place. This is the second line: a
 * browser marks a cross-site request with Sec-Fetch-Site, and an Origin that
 * names another host is refused. A request with neither header did not come
 * from a browser page, so it carries no ambient cookie to abuse.
 */
export function fromThisSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;

  const origin = request.headers.get("origin");
  if (origin) {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    try {
      if (!host || new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}
