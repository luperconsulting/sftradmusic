// Sessions persist across reloads through Supabase's own assurance level. The server decides from the
// access token's aal claim (never a client flag), and Sign out ends only this browser.
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { signOutAllBrowsers, signOutThisBrowser } from "../src/portal/auth/session";

// Supabase's getUser is mocked: it accepts any token and returns the user with a verified TOTP factor.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "teach", email: "luperdev+teacher@gmail.com", factors: [{ id: "f1", status: "verified", factor_type: "totp" }] } }, error: null }),
      admin: {},
    },
    from: () => ({}),
  }),
}));

const { createSupabaseAuthAdmin } = await import("../server/store/supabaseStore");
const { createApp } = await import("../server/app");
const { buildDeps } = await import("./helpers");

const token = (claims: object) => `h.${Buffer.from(JSON.stringify({ sub: "teach", ...claims })).toString("base64url")}.s`;

describe("teacher API routes use the JWT's aal claim", () => {
  const auth = createSupabaseAuthAdmin("https://project.supabase.co", "sb_secret_test_only_not_real", "https://app.example.com");

  it("reads the assurance level from the verified token", async () => {
    expect((await auth.verifyToken(token({ aal: "aal1" })))!.aal).toBe("aal1");
    expect((await auth.verifyToken(token({ aal: "aal2" })))!.aal).toBe("aal2");
    expect((await auth.verifyToken(token({})))!.aal).toBe("aal1");
  });

  it("rejects aal1 tokens on teacher routes and accepts aal2", async () => {
    const deps = buildDeps({ teach: { role: "teacher" } });
    deps.auth = { ...deps.auth!, verifyToken: (t: string) => auth.verifyToken(t) };
    const app = createApp(deps);
    for (const path of ["/api/teacher/students", "/api/teacher/invoices", "/api/teacher/studio", "/api/teacher/payment-reports"]) {
      const weak = await request(app).get(path).set("Authorization", `Bearer ${token({ aal: "aal1" })}`);
      expect(weak.status, path).toBe(403);
      expect(weak.body.error.code, path).toBe("mfa_required");
    }
    const strong = await request(app).get("/api/teacher/students").set("Authorization", `Bearer ${token({ aal: "aal2" })}`);
    expect(strong.status).toBe(200);
    // The routing endpoint answers at aal1 with only what the 2FA screen needs.
    const me = await request(app).get("/api/me").set("Authorization", `Bearer ${token({ aal: "aal1" })}`);
    expect(me.body).toEqual({ mfaRequired: true, user: { role: "teacher", mfaEnabled: true, aal: "aal1" } });
  });
});

describe("sign out", () => {
  /** Two browsers signed in to the same login, sharing one Supabase Auth server. */
  function twoBrowsers() {
    const server = new Set(["browser-a", "browser-b"]);
    const browser = (id: string) => ({
      auth: {
        signOut: vi.fn(async ({ scope }: { scope: "local" | "global" }) => {
          if (scope === "global") server.clear();
          else server.delete(id);
        }),
        getSession: async () => ({ data: { session: server.has(id) ? { access_token: id } : null } }),
        mfa: { listFactors: async () => ({ data: { totp: [] } }), getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2", nextLevel: "aal2" } }) },
      },
    });
    return { server, a: browser("browser-a"), b: browser("browser-b") };
  }

  it("Sign out ends only this browser; the other browser stays signed in", async () => {
    const { a, b } = twoBrowsers();
    await signOutThisBrowser(a);
    expect(a.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect((await a.auth.getSession()).data.session).toBeNull();
    expect((await b.auth.getSession()).data.session).toEqual({ access_token: "browser-b" });
  });

  it("Sign out everywhere ends every browser's session", async () => {
    const { a, b } = twoBrowsers();
    await signOutAllBrowsers(a);
    expect(a.auth.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect((await b.auth.getSession()).data.session).toBeNull();
  });

  it("the portal's Sign out uses local scope and Settings > Security offers Sign out everywhere", async () => {
    const { readFileSync } = await import("node:fs");
    const ctx = readFileSync("src/portal/auth/AuthContext.tsx", "utf8");
    expect(ctx).toMatch(/const signOut = useCallback\(async \(\) => \{[\s\S]*?signOutThisBrowser\(supabase\)/);
    expect(ctx).toMatch(/const signOutEverywhere = useCallback\(async \(\) => \{[\s\S]*?signOutAllBrowsers\(supabase\)/);
    expect(ctx).not.toMatch(/supabase\?*\.auth\.signOut\(\)/);
    expect(readFileSync("src/portal/views/teacher/SettingsView.tsx", "utf8")).toContain("Sign out everywhere");
    // No in-memory sign-in flag remains, and no custom session timeouts were added.
    const files = ["src/portal/auth/session.ts", "src/portal/auth/AuthContext.tsx", "src/portal/vm/useAuthVM.ts", "src/portal/auth/supabase.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
    expect(files).not.toMatch(/teacherGate|markPasswordVerified|markMfaVerified|setTimeout\([^)]*sign/i);
    expect(readFileSync("src/portal/auth/supabase.ts", "utf8")).toContain("createClient(url!, key!)");
  });
});
