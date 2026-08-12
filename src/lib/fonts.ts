import { Grenze_Gotisch, Inter, Pirata_One, Space_Mono } from "next/font/google";

/**
 * The mockup pulled these from the Google Fonts CDN. `next/font` self-hosts them
 * instead: no render-blocking request to fonts.googleapis.com, no layout shift,
 * and no third party seeing your visitors. Each one exposes a CSS variable that
 * `globals.css` maps onto the design tokens (--gothic, --head, --body, --mono).
 */

/** Display face. Masthead wordmark, section headings, the certificate. */
export const gothic = Pirata_One({
  variable: "--font-gothic",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

/** Blackletter workhorse. Buttons, nav items, table-ish labels. Variable weight. */
export const head = Grenze_Gotisch({
  variable: "--font-head",
  subsets: ["latin"],
  display: "swap",
});

/** Body copy. Variable weight. */
export const body = Inter({
  variable: "--font-body",
  subsets: ["latin"],
  display: "swap",
});

/** Bureaucratic detail: form numbers, field labels, serials, the eyebrow rules. */
export const mono = Space_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

export const fontVariables = [gothic, head, body, mono]
  .map((f) => f.variable)
  .join(" ");
