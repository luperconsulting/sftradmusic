import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseKeyKind } from "../../../shared/supabase-keys";
import { readRecoveryLink, type RecoverySignals } from "./recovery";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Only a public key belongs here (publishable or legacy anon). With no configuration, or a secret key put here
// by mistake, there is no client and sign-in fails closed.
const usable = !!url && !!key && supabaseKeyKind(key) !== "secret";
if (key && !usable) console.error("[portal] Refusing to start Supabase: VITE_SUPABASE_ANON_KEY must be a public key.");
// Read before createClient, which takes the reset link out of the URL while it signs the visitor in.
const recoveryLink = typeof window !== "undefined" ? readRecoveryLink(window.location.hash) : null;

export const supabase: SupabaseClient | null = usable ? createClient(url!, key!) : null;

// Supabase fires this after saving the session, on a later tick, so it's one signal among several.
let recoveryEventSeen = false;
supabase?.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") recoveryEventSeen = true;
});
export const recoverySignals: RecoverySignals = { link: recoveryLink, eventSeen: () => recoveryEventSeen };

// Dev-only sample mode. The DEV check is compiled away, so production bundles can't contain it.
export const DEMO_MODE = import.meta.env.DEV && import.meta.env.VITE_PORTAL_DEMO === "true";
