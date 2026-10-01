"use client";

import { FirebaseError } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as signOutOfFirebase,
  updateProfile,
  type User,
} from "firebase/auth";
import { clientAuth } from "@/lib/firebase/client";

/**
 * Signing in and out, in the browser.
 *
 * There are two halves to a session and they move together. The Firebase JS
 * SDK holds the browser's own sign-in — the admin console calls Cloud Functions
 * with it. The httpOnly session cookie, made by /api/session from the SDK's ID
 * token, is what the server reads. Signing in sets both; signing out clears
 * both; and SessionSync clears both whenever a page finds them disagreeing.
 *
 * No role is settable from here. Roles are custom claims, which only the Admin
 * SDK can set.
 */

export type AuthResult = { error?: string };

const MESSAGES: Record<string, string> = {
  "auth/invalid-credential": "That email and password don't match an account.",
  "auth/wrong-password": "That email and password don't match an account.",
  "auth/user-not-found": "That email and password don't match an account.",
  "auth/user-disabled": "This account has been closed.",
  "auth/email-already-in-use": "That email already has an account. Sign in instead.",
  "auth/invalid-email": "That doesn't look like an email address.",
  "auth/weak-password": "Choose a longer password.",
  "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
  "auth/network-request-failed": "Couldn't reach the sign-in service. Check your connection.",
};

function explain(err: unknown): string {
  return (err instanceof FirebaseError && MESSAGES[err.code]) || "That did not work.";
}

/**
 * Turn the SDK's sign-in into the server's session cookie. If the server will
 * not take it, sign the SDK out again, so neither half exists without the other.
 */
async function startSession(user: User): Promise<AuthResult> {
  const idToken = await user.getIdToken(true);
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  }).catch(() => null);

  if (res?.ok) return {};
  await signOutOfFirebase(clientAuth());
  return { error: "Couldn't start your session. Try again." };
}

export async function signIn(input: { email: string; password: string }): Promise<AuthResult> {
  try {
    const { user } = await signInWithEmailAndPassword(clientAuth(), input.email, input.password);
    return await startSession(user);
  } catch (err) {
    return { error: explain(err) };
  }
}

export async function signUp(input: {
  email: string;
  password: string;
  name: string;
}): Promise<AuthResult> {
  try {
    const { user } = await createUserWithEmailAndPassword(clientAuth(), input.email, input.password);
    // Before the session starts, so the name is in the token the cookie is
    // made from. The users/{uid} document and the member role come from the
    // onUserCreate Cloud Function, a moment later.
    await updateProfile(user, { displayName: input.name });
    return await startSession(user);
  } catch (err) {
    return { error: explain(err) };
  }
}

/**
 * Server first: /api/session revokes the account's refresh tokens and clears
 * the cookie. Then the SDK, whose own tokens that revocation has just ended.
 */
export async function signOut(): Promise<void> {
  await fetch("/api/session", { method: "DELETE" }).catch(() => {});
  await signOutOfFirebase(clientAuth());
}
