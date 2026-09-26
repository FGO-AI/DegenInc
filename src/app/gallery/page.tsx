import type { Metadata } from "next";
import { Footer } from "@/components/chrome/Footer";
import { Masthead } from "@/components/chrome/Masthead";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow, Section, Wrap } from "@/components/ui/Layout";

export const metadata: Metadata = {
  title: "Gallery",
};

/**
 * Photographs of the runs. There are none.
 *
 * Static for now, which is the honest shape: nothing has been shot, so there
 * is nothing to read. When there is, the grid drops into the slot marked
 * below and the empty state becomes the fallback for an empty result — the
 * same arrangement FilingGrid already uses.
 */
export default function GalleryPage() {
  return (
    <>
      <Masthead />

      <Section tone="clear">
        <Wrap>
          <Eyebrow
            left={
              <>
                Gallery <b>/ no images</b>
              </>
            }
            right="Form DI-12"
          />

          {/* The photo grid goes here, above the empty state. */}

          <EmptyState title="Nothing to look at yet">
            No filing has shipped, so nothing has been photographed. The
            pictures go up here as the runs go out.
          </EmptyState>
        </Wrap>
      </Section>

      <Footer note="Gallery" form="Form DI-12 / rev. 2026" />
    </>
  );
}
