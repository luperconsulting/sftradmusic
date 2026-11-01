import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseKeyKind } from "../../../shared/supabase-keys";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Only a public key belongs here (publishable or legacy anon). With no configuration, or a secret key put here
// by mistake, there is no client and sign-in fails closed.
const usable = !!url && !!key && supabaseKeyKind(key) !== "secret";
if (key && !usable) console.error("[portal] Refusing to start Supabase: VITE_SUPABASE_ANON_KEY must be a public key.");
export const supabase: SupabaseClient | null = usable ? createClient(url!, key!) : null;

// True only after Supabase itself accepted a recovery link in this page load. Registered straight after
// createClient, because the client processes the link while it initializes.
let recoveryVerified = false;
supabase?.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") recoveryVerified = true;
});
export const hasVerifiedRecovery = () => recoveryVerified;

// Dev-only sample mode. The DEV check is compiled away, so production bundles can't contain it.
export const DEMO_MODE = import.meta.env.DEV && import.meta.env.VITE_PORTAL_DEMO === "true";
