"use client";

import { onAuthStateChanged } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { clientAuth } from "@/lib/firebase/client";
import { signOut } from "./client";

/**
 * Keeps the SDK's sign-in and the session cookie from disagreeing.
 *
 * `uid` is who the server found in the cookie when it rendered this page, or
 * null. Once the SDK has restored its own sign-in, the two are compared, and
 * if they differ, both are signed out:
 *
 *   - cookie expired or revoked, SDK still signed in: the case that matters,
 *     since the admin console's Cloud Function calls use the SDK's sign-in;
 *   - cookie valid, SDK signed out (its storage cleared, say);
 *   - each signed in as a different account.
 *
 * Only the state the page loaded with is compared. Every later change comes
 * from signIn() or signOut(), which move both halves themselves — and mid
 * sign-in the SDK is signed in a moment before the cookie exists, which must
 * not count as a disagreement. When the page refreshes with a new `uid`, the
 * comparison runs again.
 *
 * Mounted where the SDK's sign-in is used: /account and every /admin page.
 */
export function SessionSync({ uid }: { uid: string | null }) {
  const router = useRouter();

  useEffect(() => {
    let compared = false;
    const stop = onAuthStateChanged(clientAuth(), (user) => {
      if (compared) return;
      compared = true;
      if ((user?.uid ?? null) === uid) return;
      void signOut().then(() => router.refresh());
    });
    return stop;
  }, [uid, router]);

  return null;
}
