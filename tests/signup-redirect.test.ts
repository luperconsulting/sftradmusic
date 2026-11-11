import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INVITE_PATH } from "../src/portal/auth/routes";

describe("retired enrollment-code page", () => {
  it("sends /signup and Create your account to the email-code invite page", () => {
    expect(INVITE_PATH).toBe("/invite");
    const app = readFileSync("src/portal/PortalApp.tsx", "utf8");
    expect(app).toContain('path="/signup"');
    expect(app).toContain("<Navigate to={INVITE_PATH} replace />");
    expect(app).not.toContain("SignUpView");
    const vm = readFileSync("src/portal/vm/useAuthVM.ts", "utf8");
    expect(vm).toContain("navigate(INVITE_PATH)");
    expect(vm).not.toContain('navigate("/signup")');
    const signin = readFileSync("src/portal/views/auth/SignInView.tsx", "utf8");
    expect(signin).toContain(">Create your account</button>");
    expect(signin).toContain("onClick={v.go.signup}");
    expect(signin).not.toContain("enrollment code");
    expect(signin).not.toContain("SFTM");
  });
});
