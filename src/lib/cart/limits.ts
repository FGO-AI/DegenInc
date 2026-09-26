/**
 * Limits the bag (client) and checkout (server) have to agree on.
 *
 * A plain module on purpose. CartProvider is "use client", and anything a
 * server module imports from a client file arrives as a client reference, not
 * a value — so the numbers cannot live there. checkout.ts is server-only, so
 * they cannot live there either.
 *
 * The server enforces these regardless of what the client does. The client
 * holds itself to them only so it never builds a bag checkout will refuse.
 */

/** Distinct variants in one order. Keeps the checkout batch bounded. */
export const MAX_LINES = 25;

/** Units of one variant in one order. Stock is the real limit; this bounds the arithmetic. */
export const MAX_QUANTITY = 99;

/** Every variant id is a UUID or a seed id like var_01. */
export const VARIANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
