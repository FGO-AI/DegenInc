import { StoreFooter } from "@/components/chrome/Footer";
import { Masthead } from "@/components/chrome/Masthead";
import { Ticker } from "@/components/chrome/Ticker";
import { FilingGrid } from "@/components/store/FilingGrid";
import { Gallery } from "@/components/store/Gallery";
import { Hero } from "@/components/store/Hero";
import { OpenCall } from "@/components/store/OpenCall";

export default function StorePage() {
  return (
    <>
      <Masthead />
      <Ticker />
      <Hero />
      <FilingGrid />
      <Gallery />
      <OpenCall />
      <StoreFooter />
    </>
  );
}
