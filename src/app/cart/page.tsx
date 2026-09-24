import type { Metadata } from "next";
import { Footer } from "@/components/chrome/Footer";
import { Masthead } from "@/components/chrome/Masthead";
import { Section, Wrap } from "@/components/ui/Layout";
import { getSession } from "@/lib/auth/guards";
import { purchaseCart } from "@/lib/db/checkout";
import { CartView } from "./CartView";

export const metadata: Metadata = {
  title: "Your bag",
};

/**
 * The bag.
 *
 * NOT guarded. The bag lives in the browser and looking at it needs no
 * account; requireMember() here would bounce a signed-out visitor holding a
 * full bag off to /account with no way back. getSession() only answers
 * "signed in or not", which decides whether the page offers "Place order" or
 * the sign-in panel. (It also makes the route dynamic — it calls
 * connection() — which a page that depends on the session has to be.)
 *
 * Signing in never leaves this page. SignInPanel calls router.refresh() when
 * it succeeds; that re-runs this component, getSession() now finds a session,
 * `signedIn` flips, and the same bag — untouched, it is in localStorage —
 * shows "Place order". The prop only decides which control to draw.
 * requireMember() inside purchaseCart() is the check that counts.
 *
 * purchaseCart is an inline Server Action (see checkout.ts for why it cannot
 * be imported by client code directly), so it is handed to the client half
 * here, as a prop.
 */
export default async function CartPage() {
  const session = await getSession();

  return (
    <>
      <Masthead />

      <Section tone="clear">
        <Wrap>
          <CartView signedIn={session !== null} placeOrder={purchaseCart} />
        </Wrap>
      </Section>

      <Footer note="Your bag" form="Form DI-08 / rev. 2026" />
    </>
  );
}
