import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";

// No explicit config in production — the Cloud Functions runtime injects the
// project id and default bucket automatically. Against the emulators,
// firebase-admin picks up FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST
// / FIREBASE_STORAGE_EMULATOR_HOST the same way `firebase emulators:exec`
// already sets them for rules.test.mjs.
initializeApp();

export const db = getFirestore();
export const auth = getAuth();
export const storage = getStorage();
export { FieldValue, Timestamp };
