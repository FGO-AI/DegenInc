// The same ActionResult<T> as src/lib/catalogue/client.ts, which is how the
// admin console calls these functions, and what Filings.tsx's useSubmit() reads.
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type FilingStatus = "draft" | "scheduled" | "live" | "closed";
