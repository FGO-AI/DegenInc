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
 * Mirrors src/lib/db/admin.ts's createFiling() (lines 54-85).
 *
 * The filing gets a random id; its number, unique as it was in D1, is held by
 * a filingNumbers/{number} lookup created in the same transaction (unique.ts).
 *
 * publicAt/memberAccessAt are accepted as optional inputs here. D1 never
 * sets these anywhere in the app — confirmed by grep, they exist only as
 * migration column definitions and scripts/seed.sql fixture constants — so
 * there's no business rule to preserve, and none is invented here.
 * updateFilingStatus() below refuses to go live without both set, rather
 * than defaulting or silently leaving the filing unable to ever become
 * visible.
 */
export const createFiling = onCall(async (request) => {
  requireStaff(request);

  return attempt(async () => {
    const data = request.data ?? {};
    const number = wholeNumber(data.number, "Filing number", 1, 999);
    const title = words(data.title, "Title", 120);
    const publicAt = optionalTimestamp(data.publicAt, "Public date");
    const memberAccessAt = optionalTimestamp(data.memberAccessAt, "Member access date");
    if (publicAt && memberAccessAt && memberAccessAt.toMillis() > publicAt.toMillis()) {
      throw new Rejected("Member access cannot start after the public date.");
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
          ...(publicAt ? { publicAt } : {}),
          ...(memberAccessAt ? { memberAccessAt } : {}),
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
 * Mirrors src/lib/db/admin.ts's updateFilingStatus() (lines 127-178).
 *
 * OWNER ONLY, same as D1 — "Taking a filing live is what puts it in front
 * of customers."
 *
 * D1 enforces "one live filing" with a partial UNIQUE index, since a CHECK
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
 * Going live (or closing) also pushes filingStatus/publicAt/memberAccessAt
 * onto every product in the filing, in this SAME transaction — the
 * invariant firestore.rules' own comments assume ("kept in sync by whichever
 * Cloud Function owns filing status changes, all three fields together, not
 * as separate updates that could drift").
 */
export const updateFilingStatus = onCall(async (request) => {
  requireOwner(request);

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
      const productsSnap = (status === "live" || status === "closed")
        ? await t.get(db.collection("products").where("filingId", "==", filingId))
        : null;
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

      if (status === "live") {
        for (const p of productsSnap!.docs) {
          t.update(p.ref, {
            filingStatus: "live",
            publicAt: filing.publicAt,
            memberAccessAt: filing.memberAccessAt,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        t.set(stateRef, { filingId });
      }

      if (status === "closed") {
        for (const p of productsSnap!.docs) {
          t.update(p.ref, { filingStatus: "closed", updatedAt: FieldValue.serverTimestamp() });
        }
        if (stateSnap!.exists && stateSnap!.data()?.filingId === filingId) {
          t.delete(stateRef);
        }
      }

      return { id: filingId, status };
    });
  });
});
