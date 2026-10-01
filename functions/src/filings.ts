import { onCall } from "firebase-functions/v2/https";
import { db, FieldValue } from "./firebase";
import { requireStaff, requireOwner, attempt, Rejected } from "./guards";
import {
  wholeNumber,
  words,
  optionalTimestamp,
  reference,
  oneOf,
  pad,
} from "./validation";
import type { FilingStatus } from "./types";
import { claimingUnique } from "./unique";

/**
 * The console's createFiling(), with the two times every filing now needs.
 *
 * The filing gets a random id; its number, which must be unique, is held by
 * a filingNumbers/{number} lookup created in the same transaction (unique.ts).
 *
 * Both times are required, and the public one must come strictly after the
 * members' one. Required because nothing can set them later — there is no
 * function to edit a filing — and a filing without them can never go live.
 * Checked here, not only in the console's form, because a form is a courtesy
 * and this is the only way in.
 */
export const createFiling = onCall(async (request) => {
  await requireStaff(request);

  return attempt(async () => {
    const data = request.data ?? {};
    const number = wholeNumber(data.number, "Filing number", 1, 999);
    const title = words(data.title, "Title", 120);
    const memberAccessAt = optionalTimestamp(data.memberAccessAt, "Member access date");
    const publicAt = optionalTimestamp(data.publicAt, "Public date");
    if (!memberAccessAt || !publicAt) {
      throw new Rejected("Set when members get in and when the public does.");
    }
    if (publicAt.toMillis() <= memberAccessAt.toMillis()) {
      throw new Rejected("The public date has to be after the members' date.");
    }

    const filingRef = db.collection("filings").doc();
    const numberRef = db.collection("filingNumbers").doc(pad(number));
    const taken = `Filing ${pad(number)} already exists.`;

    const filing = await claimingUnique({ filingNumbers: taken }, () =>
      db.runTransaction(async (t) => {
        if ((await t.get(numberRef)).exists) throw new Rejected(taken);

        const doc = {
          number,
          title,
          status: "draft" as const,
          memberAccessAt,
          publicAt,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        t.create(numberRef, { filingId: filingRef.id });
        t.create(filingRef, doc);
        return doc;
      }),
    );

    return { id: filingRef.id, number: filing.number, title: filing.title, status: filing.status, products: [] };
  });
});

const STATUSES = ["draft", "scheduled", "live", "closed"] as const;

/** Each status, and the one status a filing may reach it from. */
const PREVIOUS: Record<FilingStatus, FilingStatus | null> = {
  draft: null,
  scheduled: "draft",
  live: "scheduled",
  closed: "live",
};

/**
 * The console's updateFilingStatus().
 *
 * OWNER ONLY, as it always was — "Taking a filing live is what puts it in front
 * of customers."
 *
 * The old SQL schema held "one live filing" with a partial UNIQUE index; a CHECK
 * constraint can't see prior state. Firestore has no partial unique index,
 * so this reads `filings where status == 'live'` *inside* the transaction
 * before writing, and leans on Firestore's serializable isolation: two
 * transactions that both read "nothing is live" cannot both commit a live
 * filing, because no serial order of them produces that. The Admin SDK uses
 * the database's concurrency mode (pessimistic by default on the Standard
 * edition), so under contention one transaction is delayed or aborted and the
 * client library retries it; the retry re-reads, sees the other filing live,
 * and rejects with its name. functions.test.mjs shows this against the
 * emulator with two go-live calls genuinely overlapping, and again with two
 * raw transactions held open between their read and their write.
 *
 * Every transition — scheduling, going live, closing — also writes the
 * filing's status, publicAt and memberAccessAt onto every one of its
 * products, in this SAME transaction. firestore.rules and
 * src/lib/visibility.ts both read a product's own copies, never its filing,
 * so a filing and its products must never disagree, not even for a moment
 * between two writes. A time the filing lacks (only a filing seeded or made
 * before times were required) is removed from the products too.
 */
export const updateFilingStatus = onCall(async (request) => {
  await requireOwner(request);

  return attempt(async () => {
    const data = request.data ?? {};
    const filingId = reference(data.filingId, "Filing");
    const status = oneOf(data.status, STATUSES, "Status");
    const from = PREVIOUS[status];
    if (!from) throw new Rejected("A filing cannot go back to draft.");

    const filingRef = db.collection("filings").doc(filingId);
    const stateRef = db.doc("state/currentFiling");

    return db.runTransaction(async (t) => {
      // ---- all reads first: Firestore transactions require every get()
      // before any write() ----
      const filingSnap = await t.get(filingRef);
      if (!filingSnap.exists) throw new Rejected("That filing no longer exists.");
      const filing = filingSnap.data()!;
      if (filing.status !== from) {
        throw new Rejected(
          `Only a ${from} filing can move to ${status}, and this one is not ${from} any more. Reload to see where it is.`,
        );
      }
      if (status === "live" && (!filing.publicAt || !filing.memberAccessAt)) {
        throw new Rejected("Set a public date and a member-access date before taking this filing live.");
      }

      const liveSnap = status === "live"
        ? await t.get(db.collection("filings").where("status", "==", "live"))
        : null;
      const productsSnap = await t.get(db.collection("products").where("filingId", "==", filingId));
      const stateSnap = status === "closed" ? await t.get(stateRef) : null;

      if (status === "live") {
        const other = liveSnap!.docs.find((d) => d.id !== filingId);
        if (other) {
          throw new Rejected(
            `Filing ${pad(other.data().number)} is still live — close it before taking this one live.`,
          );
        }
      }

      // ---- writes ----
      t.update(filingRef, { status, updatedAt: FieldValue.serverTimestamp() });

      for (const p of productsSnap.docs) {
        t.update(p.ref, {
          filingStatus: status,
          publicAt: filing.publicAt ?? FieldValue.delete(),
          memberAccessAt: filing.memberAccessAt ?? FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      if (status === "live") t.set(stateRef, { filingId });

      if (status === "closed" && stateSnap!.exists && stateSnap!.data()?.filingId === filingId) {
        t.delete(stateRef);
      }

      return { id: filingId, status };
    });
  });
});
