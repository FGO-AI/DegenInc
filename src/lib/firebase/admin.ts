import "server-only";

import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

/**
 * The Admin SDK, for the Next server only.
 *
 * initializeApp() takes no arguments and there is no key file anywhere. On App
 * Hosting the runtime supplies the credentials and FIREBASE_CONFIG (project and
 * default bucket). Locally, .env.development sets FIREBASE_CONFIG and the
 * *_EMULATOR_HOST variables, which point every call at the emulators instead.
 *
 * THE ADMIN SDK BYPASSES firestore.rules AND storage.rules. Nothing read or
 * written through it is protected by them. That is why every server data
 * function calls a guard from src/lib/auth/guards.ts first, and why anything
 * that decides visibility here goes through src/lib/visibility.ts: the rules
 * protect the client and mobile paths, the guards protect this one.
 *
 * getApps() first because `next dev` re-evaluates modules, and a second
 * initializeApp() of the default app throws.
 */
const app = getApps()[0] ?? initializeApp();

export const adminAuth = () => getAuth(app);
export const adminDb = () => getFirestore(app);
export const adminBucket = () => getStorage(app).bucket();
