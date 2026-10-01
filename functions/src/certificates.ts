import { db, FieldValue } from "./firebase";
import { Rejected } from "./guards";

/**
 * Issue the member's certificate for a paid order, or return the one they have.
 *
 * NOT CALLED YET, and not a deployed function. It belongs to the step that
 * marks an order paid, which does not exist until Stripe does — checkout
 * deliberately does not call it, so an unpaid order never uses up a number.
 * functions.test.mjs calls it directly.
 *
 * One certificate per member, forever: the document is certificates/{memberId},
 * so a second paid order finds it and gets the same number back.
 *
 * Numbers come from counters/certificates, incremented in the same transaction
 * that creates the certificate. Either both land or neither does, so a failed
 * issue skips no number, and since the counter is read inside the transaction,
 * two issued at once cannot get the same one: Firestore runs one of them again,
 * and it reads the other's increment.
 */
export async function issueCertificate(orderId: string): Promise<{ number: number; issued: boolean }> {
  const orderRef = db.doc(`orders/${orderId}`);
  const counterRef = db.doc("counters/certificates");

  return db.runTransaction(async (t) => {
    const order = await t.get(orderRef);
    if (!order.exists) throw new Rejected("There is no such order.");
    if (order.get("status") !== "paid") {
      throw new Rejected("Only a paid order is issued a certificate.");
    }

    const memberId = order.get("memberId") as string;
    const certRef = db.doc(`certificates/${memberId}`);
    const [cert, counter] = await Promise.all([t.get(certRef), t.get(counterRef)]);
    if (cert.exists) return { number: cert.get("number") as number, issued: false };

    const number = ((counter.get("value") as number | undefined) ?? 0) + 1;
    t.set(counterRef, { value: number });
    t.create(certRef, {
      number,
      memberId,
      orderId,
      class: "founding",
      issuedAt: FieldValue.serverTimestamp(),
    });
    return { number, issued: true };
  });
}
