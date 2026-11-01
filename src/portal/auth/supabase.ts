import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Only the public anon key belongs here. With no configuration there is no client, so sign-in fails closed.
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;

// Dev-only sample mode. The DEV check is compiled away, so production bundles can't contain it.
export const DEMO_MODE = import.meta.env.DEV && import.meta.env.VITE_PORTAL_DEMO === "true";
