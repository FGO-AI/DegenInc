// Mirrors src/lib/db/admin.ts's ActionResult<T> so Filings.tsx's useSubmit()
// needs no changes when it's later wired to call these functions instead of
// the D1 Server Actions it calls today.
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type FilingStatus = "draft" | "scheduled" | "live" | "closed";
