import { getCartDetails } from "@/lib/db/queries";

/**
 * PUBLIC. Current name, price and stock for the variants in a bag.
 *
 *   GET /api/cart?v=<variantId>&v=<variantId>
 *
 * The bag lives in the browser, so the bag page has to ask for this from the
 * client. A Route Handler rather than a Server Action because it is a read:
 * actions are POST-only and dispatched one at a time per client, so a stock
 * refresh would queue behind a checkout in flight. Next's guidance points reads
 * from client code here for the same reason.
 *
 * getCartDetails() validates and caps the ids itself — this passes along
 * whatever arrived, and it is a public function either way.
 *
 * Node.js runtime. Do not add `export const runtime = "edge"`.
 */
export async function GET(request: Request): Promise<Response> {
  const ids = new URL(request.url).searchParams.getAll("v");
  const lines = await getCartDetails(ids);

  // Stock is the point of this response; nothing along the way should keep it.
  return Response.json(
    { lines },
    { headers: { "cache-control": "no-store" } },
  );
}
