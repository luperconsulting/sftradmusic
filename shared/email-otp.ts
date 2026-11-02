// Supabase email OTP length is a project setting (often 6 or 8). {{ .Token }} is that code,
// and verifyOtp type "email" checks it. Accept the whole range the dashboard can send.
export const EMAIL_OTP_MIN = 6;
export const EMAIL_OTP_MAX = 10;

export function isEmailOtp(code: string) {
  return new RegExp(`^\\d{${EMAIL_OTP_MIN},${EMAIL_OTP_MAX}}$`).test(code);
}
