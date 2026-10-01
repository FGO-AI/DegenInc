import { Timestamp } from "firebase-admin/firestore";
import { Rejected } from "./guards";

// Ported from the console's original validation helpers — same
// validation, same messages, so a staffer sees no difference in what a bad
// input tells them.

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function words(value: unknown, label: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Rejected(`${label} is required.`);
  if (text.length > max) {
    throw new Rejected(`${label} is capped at ${max} characters.`);
  }
  return text;
}

export function optionalWords(
  value: unknown,
  label: string,
  max: number,
): string | null {
  if (value == null || (typeof value === "string" && !value.trim())) {
    return null;
  }
  return words(value, label, max);
}

export function wholeNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Rejected(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/**
 * An id the client is pointing at. Every filing, product and variant id is a
 * Firestore auto-id (20 letters and digits) or a seeded one like fil_001, so
 * anything outside [A-Za-z0-9_-] is refused outright rather than sent to
 * Firestore. Whether the document exists is each function's own check.
 */
export function reference(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Rejected(`${label} is missing or malformed.`);
  }
  return value;
}

export function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new Rejected(`${label} must be one of ${options.join(", ")}.`);
  }
  return value as T;
}

export const pad = (n: number): string => String(n).padStart(3, "0");

/** Parses an optional ISO date string into a Timestamp, or undefined. */
export function optionalTimestamp(value: unknown, label: string): Timestamp | undefined {
  if (value == null || value === "") return undefined;
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new Rejected(`${label} is not a valid date.`);
  return Timestamp.fromMillis(ms);
}

/**
 * Builds a Firestore document id out of one or more parts, joined with "_" —
 * the same shape as the existing votes/{filingId}_{memberId} pattern. In the
 * old SQL schema size/color/sku were just text columns. Here they become (part
 * of) a literal document id, which Firestore restricts more than a text
 * column ever was — this is what enforces that.
 */
export function docIdFrom(...parts: string[]): string {
  const id = parts.map(encodeURIComponent).join("_");
  if (id === "." || id === "..") {
    throw new Rejected("That value cannot be used as-is.");
  }
  if (/^__.*__$/.test(id)) {
    throw new Rejected("That value cannot be used as-is.");
  }
  return id;
}
