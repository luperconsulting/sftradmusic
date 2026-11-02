// A teacher session restored from the browser is not a login. Password and the 2FA
// challenge have to happen again in this page load before any teacher page opens.
let passwordVerified = false;
let mfaVerified = false;

export function markPasswordVerified() {
  passwordVerified = true;
}

export function markMfaVerified() {
  mfaVerified = true;
}

export function resetTeacherGate() {
  passwordVerified = false;
  mfaVerified = false;
}

export function teacherGateState() {
  return { passwordVerified, mfaVerified };
}

/** Restored sessions have neither flag. Only a teacher is sent back to sign in. */
export function teacherMustReauthenticate(role: string | undefined) {
  return role === "teacher" && !passwordVerified;
}

/** Password and the authenticator challenge both happened in this page load. */
export function teacherPortalReady() {
  return passwordVerified && mfaVerified;
}

/** Password was entered here, and the authenticator challenge is still required. */
export function teacherMfaPending(role: string | undefined, aal: string | undefined) {
  return role === "teacher" && passwordVerified && (!mfaVerified || aal !== "aal2");
}
