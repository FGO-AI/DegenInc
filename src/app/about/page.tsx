import type { Metadata } from "next";
import { Footer } from "@/components/chrome/Footer";
import { Masthead } from "@/components/chrome/Masthead";
import { Memo } from "./Memo";

export const metadata: Metadata = {
  title: "About",
};

/**
 * The charter, on its own page.
 *
 * It used to be the second band of the homepage, which meant a visitor read a
 * thousand words about why the company exists before seeing a single garment.
 * It is the same memo, unchanged — it just has to be asked for now.
 */
export default function AboutPage() {
  return (
    <>
      <Masthead />
      <Memo />
      <Footer note="The charter" form="Form DI-01 / rev. 2026" />
    </>
  );
}
