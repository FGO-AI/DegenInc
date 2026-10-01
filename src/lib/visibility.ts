import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import type { SessionUser } from "@/lib/auth/guards";

/**
 * Whether a filing — or a product, through its own copies of its filing's
 * fields — can be seen right now. The one place the server decides this.
 *
 * THIS MUST AGREE WITH isVisible() IN firestore.rules. The rules answer the
 * question for the browser and the mobile apps; this answers it for the Next
 * server, which reads with the Admin SDK and so is not protected by the rules
 * at all. Change one, change the other, the same way.
 *
 *   - closed is visible, outright;
 *   - live is visible once publicAt has passed, or earlier to a signed-in
 *     member once memberAccessAt has passed;
 *   - anything else — draft, scheduled — is not;
 *   - staff see everything (the rules add `|| isStaff()` to each read; here it
 *     rides in on the viewer).
 *
 * A missing or non-timestamp publicAt or memberAccessAt counts as "not yet",
 * as it does in the rules, where comparing request.time with it is an
 * evaluation error that grants nothing. `now` is the server's clock, as
 * request.time is the rules'.
 */
export type Viewer = { signedIn: boolean; staff: boolean };

export function viewerOf(session: SessionUser | null): Viewer {
  return {
    signedIn: session !== null,
    staff: session?.role === "staff" || session?.role === "owner",
  };
}

export function isVisible(
  status: unknown,
  data: { publicAt?: unknown; memberAccessAt?: unknown },
  viewer: Viewer,
  now: number = Date.now(),
): boolean {
  if (viewer.staff) return true;
  if (status === "closed") return true;
  if (status !== "live") return false;
  if (hasPassed(data.publicAt, now)) return true;
  return viewer.signedIn && hasPassed(data.memberAccessAt, now);
}

function hasPassed(moment: unknown, now: number): boolean {
  return moment instanceof Timestamp && now >= moment.toMillis();
}
