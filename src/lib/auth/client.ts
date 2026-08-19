"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser auth client.
 *
 * This talks to /api/auth/*, never to the database. There is no database
 * credential in the browser because none exists — D1 is a Worker binding, so
 * there is no public endpoint to point a client at.
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
});

export const { signIn, signUp, signOut, useSession } = authClient;
