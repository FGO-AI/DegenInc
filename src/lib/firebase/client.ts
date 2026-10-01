"use client";

import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import {
  connectFunctionsEmulator,
  getFunctions,
  type Functions,
} from "firebase/functions";

/**
 * The Firebase JS SDK, for the browser.
 *
 * NEXT_PUBLIC_FIREBASE_CONFIG is the web app's config as JSON — apiKey,
 * authDomain, projectId and so on. None of it is secret: it identifies the
 * project, and what anyone may do with it is decided by Authentication,
 * firestore.rules and storage.rules. Like every NEXT_PUBLIC_ value it is inlined
 * when the app is built, so it must be present at build time.
 *
 * NEXT_PUBLIC_FIREBASE_EMULATORS=true points the SDK at the local emulators, on
 * the ports in firebase.json. .env.development sets both for `next dev`.
 *
 * Call these from event handlers and effects, never during render: client
 * components render on the server too, where there is no browser to sign in.
 */
const EMULATORS = process.env.NEXT_PUBLIC_FIREBASE_EMULATORS === "true";

function firebaseApp(): FirebaseApp {
  const existing = getApps()[0];
  if (existing) return existing;

  const raw = process.env.NEXT_PUBLIC_FIREBASE_CONFIG;
  if (!raw) {
    throw new Error(
      "NEXT_PUBLIC_FIREBASE_CONFIG is not set. It holds the web app config " +
        "from the Firebase console (Project settings → Your apps), as JSON.",
    );
  }
  return initializeApp(JSON.parse(raw));
}

let auth: Auth | undefined;
export function clientAuth(): Auth {
  if (auth) return auth;
  auth = getAuth(firebaseApp());
  if (EMULATORS) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  }
  return auth;
}

let functions: Functions | undefined;
export function clientFunctions(): Functions {
  if (functions) return functions;
  functions = getFunctions(firebaseApp());
  if (EMULATORS) connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return functions;
}
