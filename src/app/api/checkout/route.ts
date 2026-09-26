import { getSession } from "@/lib/auth/guards";
import {
  FilingClosedError,
  InvalidOrderError,
  OutOfStockError,
  purchaseVariant,
} from "@/lib/db/checkout";

/**
 * Reserve stock for the signed-in member.
 *
 * Uses getSession() rather than requireMember(): a guard that calls redirect()
 * is right for a page, but an API client wants a 401, not a 307 to HTML.
 * Either way the decision is made on the server from the session cookie —
 * never from anything in the request body.
 *
 * Node.js runtime. Do not add `export const runtime = "edge"`.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }

  let body: { variantId?: string; quantity?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON" }, { status: 400 });
  }

  if (!body.variantId) {
    return Response.json({ error: "variantId is required" }, { status: 400 });
  }

  try {
    const { orderId } = await purchaseVariant({
      // From the session, never the payload.
      userId: session.id,
      variantId: body.variantId,
      quantity: body.quantity ?? 1,
    });
    return Response.json({ ok: true, orderId });
  } catch (err) {
    if (err instanceof OutOfStockError) {
      return Response.json({ ok: false, error: "out_of_stock" }, { status: 409 });
    }
    // Same shape: a real product, on sale a moment ago, and nothing written.
    if (err instanceof FilingClosedError) {
      return Response.json({ ok: false, error: "filing_closed" }, { status: 409 });
    }
    // An unknown variant or a quantity below 1, refused before any write.
    // (A bad quantity used to reach the batch, trip the order_items quantity
    // CHECK and come back here as a misleading out_of_stock.)
    if (err instanceof InvalidOrderError) {
      return Response.json({ ok: false, error: err.message }, { status: 400 });
    }
    throw err;
  }
}
