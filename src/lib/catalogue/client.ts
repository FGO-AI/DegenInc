"use client";

import { httpsCallable } from "firebase/functions";
import { clientFunctions } from "@/lib/firebase/client";
import type {
  AdminFiling,
  AdminImage,
  AdminProduct,
  AdminVariant,
  FilingStatus,
} from "@/lib/db/queries";

/**
 * The admin console's catalogue actions: Cloud Function calls, from the
 * browser, with the SDK's own sign-in (src/lib/auth/client.ts).
 *
 * Firestore refuses every client write to filings, products and variants, so
 * these functions are the only way in. The console is only ever rendered after
 * the /admin layout's requireStaff() has passed on the server, and each
 * function checks the caller's staff or owner claim again itself — against a
 * token it re-verifies for revocation — so neither check leans on the other.
 *
 * Each returns the function's own { ok, data } or { ok: false, error }, the
 * shape Filings.tsx's useSubmit() expects. A refused call (signed out, wrong
 * role) or an unexpected failure throws instead, and useSubmit() shows its
 * generic message, as it did for a thrown Server Action.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

async function call<In, Out>(name: string, input: In): Promise<ActionResult<Out>> {
  const result = await httpsCallable<In, ActionResult<Out>>(clientFunctions(), name)(input);
  return result.data;
}

export function createFiling(input: {
  number: number;
  title: string;
  memberAccessAt: string;
  publicAt: string;
}): Promise<ActionResult<AdminFiling>> {
  return call("createFiling", input);
}

export function updateFilingStatus(input: {
  filingId: string;
  status: FilingStatus;
}): Promise<ActionResult<{ id: string; status: FilingStatus }>> {
  return call("updateFilingStatus", input);
}

export function createProduct(input: {
  filingId: string;
  slug: string;
  name: string;
  kind: string;
  description?: string;
  priceCents: number;
}): Promise<ActionResult<AdminProduct>> {
  return call("createProduct", input);
}

export function createVariant(input: {
  productId: string;
  size: string;
  color: string;
  sku: string;
  stock: number;
}): Promise<ActionResult<AdminVariant>> {
  return call("createVariant", input);
}

/**
 * Takes the form, as the Server Action did. A callable's input is JSON, so the
 * file travels as base64; the function sniffs the decoded bytes, and nothing
 * the browser says about the file — its name, its type — goes along.
 */
export async function uploadProductImage(form: FormData): Promise<ActionResult<AdminImage>> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose an image to upload." };
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return call("uploadProductImage", {
    productId: form.get("productId"),
    fileBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
  });
}
