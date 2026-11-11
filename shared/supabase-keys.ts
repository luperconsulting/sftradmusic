// Supabase issues two key formats: opaque sb_publishable_/sb_secret_ keys, and legacy anon/service_role JWTs.
// supabase-js accepts both, so the format only matters for catching a key put in the wrong place.
export type SupabaseKeyKind = "public" | "secret" | "unknown";

export function supabaseKeyKind(key: string): SupabaseKeyKind {
  if (key.startsWith("sb_publishable_")) return "public";
  if (key.startsWith("sb_secret_")) return "secret";
  try {
    const payload = key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const role = JSON.parse(atob(payload)).role;
    if (role === "anon") return "public";
    if (role === "service_role") return "secret";
  } catch {
    /* not a JWT */
  }
  return "unknown";
}
