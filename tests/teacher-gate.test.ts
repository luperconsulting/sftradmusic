import { describe, expect, it } from "vitest";
import { isEmailOtp } from "../shared/email-otp";
import { markMfaVerified, markPasswordVerified, resetTeacherGate, teacherMfaPending, teacherMustReauthenticate, teacherPortalReady } from "../src/portal/auth/teacherGate";

describe("teacher sign-in gate", () => {
  it("rejects a restored teacher session until this page gets a password and a 2FA challenge", () => {
    resetTeacherGate();
    expect(teacherMustReauthenticate("teacher")).toBe(true);
    expect(teacherMustReauthenticate("guardian")).toBe(false);
    expect(teacherMustReauthenticate("student")).toBe(false);
    markPasswordVerified();
    expect(teacherMustReauthenticate("teacher")).toBe(false);
    expect(teacherMfaPending("teacher", "aal2")).toBe(true);
    expect(teacherMfaPending("teacher", "aal1")).toBe(true);
    expect(teacherPortalReady()).toBe(false);
    markMfaVerified();
    expect(teacherPortalReady()).toBe(true);
    expect(teacherMfaPending("teacher", "aal1")).toBe(true);
    expect(teacherMfaPending("teacher", "aal2")).toBe(false);
  });
});

describe("email OTP length", () => {
  it("accepts 6 to 10 digits, which covers Supabase's configurable OTP", () => {
    expect(isEmailOtp("482913")).toBe(true);
    expect(isEmailOtp("48291370")).toBe(true);
    expect(isEmailOtp("1234567890")).toBe(true);
    expect(isEmailOtp("12345")).toBe(false);
    expect(isEmailOtp("12345678901")).toBe(false);
    expect(isEmailOtp("4829137a")).toBe(false);
  });
});
