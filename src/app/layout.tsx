import type { Metadata, Viewport } from "next";
import { DitherField } from "@/components/chrome/DitherField";
import { Drawer } from "@/components/chrome/Drawer";
import { DrawerProvider } from "@/components/chrome/DrawerProvider";
import { Overlays } from "@/components/chrome/Overlays";
import { SvgFilters } from "@/components/chrome/SvgFilters";
import { CartProvider } from "@/lib/cart/CartProvider";
import { fontVariables } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Degenerates Inc.",
    template: "%s / Degenerates Inc.",
  },
  description:
    "Clothing printed in small runs, then it's gone. Every order ships with a numbered certificate. Est. 2026, Jacksonville NC.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={fontVariables}>
      <body>
        {/* Ambient layer, z-index 0-1, behind everything and non-interactive. */}
        <SvgFilters />
        <DitherField />
        <Overlays />

        {/* The bag wraps everything that renders a Masthead, which is every
            page, so one count serves them all. */}
        <CartProvider>
          <DrawerProvider>
            <Drawer />
            {/* z-index 2 — lifts the page above the canvas and its overlays. */}
            <div className="stack">{children}</div>
          </DrawerProvider>
        </CartProvider>
      </body>
    </html>
  );
}
