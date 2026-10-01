import { Rejected } from "./guards";

/**
 * Unique values — a filing number, a slug, a SKU, a product's size and colour
 * — are each held by a lookup document whose id is the value, created with
 * create() in the same transaction as the record that owns it. create() only
 * succeeds if that document does not exist yet, and Firestore checks it when
 * the transaction commits. That is the guarantee: not a query, and not the
 * read that comes first.
 *
 * Every lookup collection is deny-all in firestore.rules; only these functions
 * write them, and nothing reads them but these functions.
 *
 * The functions do read each lookup first, inside the transaction, but only so
 * a duplicate fails with a sentence. Two requests racing for one value usually
 * end with the loser's transaction retried by the client library, seeing the
 * lookup, and rejecting with that sentence. If the race is settled at commit
 * instead, Firestore fails the commit with ALREADY_EXISTS and names the
 * document; this maps that to the same sentence.
 */
export async function claimingUnique<T>(
  reasons: Record<string, string>,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const { code, message } = err as { code?: unknown; message?: unknown };
    if (code === 6 /* ALREADY_EXISTS */ && typeof message === "string") {
      for (const [collection, reason] of Object.entries(reasons)) {
        if (message.includes(`/documents/${collection}/`)) throw new Rejected(reason);
      }
    }
    throw err;
  }
}
