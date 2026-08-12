import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client.
 *
 * Returns `null` when the env vars are unset, and every caller must handle
 * that. It keeps the app runnable with no backend at all — the current state
 * of the project — instead of crashing at import time on a missing key.
 *
 * Only the publishable (anon) key belongs here. It is designed to ship in
 * client code; Row Level Security is what actually protects the data. The
 * service_role key bypasses RLS entirely and must never reach the browser.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!url || !anonKey) return null;
  cached ??= createClient(url, anonKey);
  return cached;
}

/** True when the app has a backend configured. */
export const isSupabaseConfigured = Boolean(url && anonKey);
