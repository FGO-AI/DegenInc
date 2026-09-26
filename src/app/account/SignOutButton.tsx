"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { signOut } from "@/lib/auth/client";

/**
 * Sign out, then re-render the server component that put us here.
 *
 * Unlike the admin console this does NOT push("/"). /account is also the
 * sign-in page, so the member stays put and the record collapses back to the
 * signed-out shell — refresh() re-runs page.tsx, whose getSession() now
 * returns null.
 */
function useSignOut() {
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function handleSignOut() {
    if (pending) return;
    setPending(true);
    // Resolves after the session-clearing Set-Cookie has been applied, so the
    // refresh below is guaranteed to be an unauthenticated request.
    await signOut();
    router.refresh();
  }

  return { pending, handleSignOut };
}

/** Masthead slot. Mirrors the control in the admin console. */
export function SignOutIconButton() {
  const { pending, handleSignOut } = useSignOut();
  return (
    <IconButton onClick={handleSignOut} disabled={pending}>
      {pending ? "..." : "Sign out"}
    </IconButton>
  );
}

/** Full-width control inside the standing panel, where sign-in used to be. */
export function SignOutButton() {
  const { pending, handleSignOut } = useSignOut();
  return (
    <Button onClick={handleSignOut} disabled={pending}>
      {pending ? "..." : "Sign out"}
    </Button>
  );
}
