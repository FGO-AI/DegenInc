import { StoreFooter } from "@/components/chrome/Footer";
import { Masthead } from "@/components/chrome/Masthead";
import { Ticker } from "@/components/chrome/Ticker";
import { Collective } from "@/components/store/Collective";
import { FilingGrid } from "@/components/store/FilingGrid";
import { Hero } from "@/components/store/Hero";
import { Memo } from "@/components/store/Memo";
import { OpenCall } from "@/components/store/OpenCall";

export default function StorePage() {
  return (
    <>
      <Masthead />
      <Ticker />
      <Hero />
      <Memo />
      <FilingGrid />
      <Collective />
      <OpenCall />
      <StoreFooter />
    </>
  );
}
