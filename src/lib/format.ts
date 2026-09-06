/**
 * Display formatting shared across the app.
 *
 * Deliberately NOT `server-only`. Money is rendered by server components today
 * — the filing grid, the member record — and will be rendered by a cart button
 * tomorrow. Two copies of a money formatter is how a site ends up printing
 * "$12.5" in one place and "$12.50" in another.
 */

/**
 * Integer cents to a display string.
 *
 * Whole dollars print bare — $40, not $40.00, because the price grid is set in
 * a display face and trailing zeros read as noise. Anything with a remainder
 * prints both digits: $12.50, never $12.5.
 */
export function money(cents: number): string {
  const exact = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: exact ? 0 : 2,
    maximumFractionDigits: exact ? 0 : 2,
  })}`;
}

/**
 * A filing-office date stamp: 2026.03.14.
 *
 * Fixed format, always UTC. `toLocaleDateString` would render in the Worker's
 * timezone, which is not the reader's, and would drift between the Cloudflare
 * runtime and a local `next dev` — so a printed date could disagree with
 * itself depending on where it was rendered.
 */
export function stamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, ".");
}
