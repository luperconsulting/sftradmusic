// Portal email through Gmail SMTP as zane@sftradmusic.com, in the SF Trad Music banner template.
// Only transactional mail to the student or payer: invoices, payments, lesson bookings. No SMS, no marketing.
// In safe mode (Preview) only SAFE_MODE_EMAIL_ALLOWLIST addresses are emailed; everything else is logged.
import nodemailer from "nodemailer";

export const SMTP_HOST = "smtp.gmail.com";
export const SMTP_PORT = 587;
export const MAIL_FROM = "SF Trad Music <zane@sftradmusic.com>";

export interface SmtpAuth {
  user: string;
  pass: string;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface PortalEmail {
  to: string;
  subject: string;
  heading: string;
  lines: string[];
  /** Optional emphasized block, such as payment instructions. */
  callout?: string[];
  cta?: { label: string; url: string };
}

export type MailResult = { emailed: boolean; suppressed: boolean; reason: "sent" | "safe_mode" | "not_configured" | "failed" };

export interface Mailer {
  send(email: PortalEmail): Promise<MailResult>;
}

export function smtpFromEnv(env: Record<string, string | undefined>): SmtpAuth | null {
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.trim();
  if (!user || !pass) return null;
  return { user, pass };
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

/** Navy banner, matching supabase/templates/invite.html. */
export function renderEmail(email: PortalEmail): { html: string; text: string } {
  const p = (t: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;">${escapeHtml(t)}</p>`;
  const callout = email.callout?.length
    ? `<div style="margin:0 0 18px;padding:14px 16px;background:#f4f1ea;border-left:3px solid #9C5F22;">${email.callout.map((t) => `<p style="margin:0 0 6px;font-size:14px;line-height:1.5;">${escapeHtml(t)}</p>`).join("")}</div>`
    : "";
  const cta = email.cta
    ? `<p style="margin:8px 0 18px;"><a href="${escapeHtml(email.cta.url)}" style="display:inline-block;background:#1D2A44;color:#ffffff;text-decoration:none;padding:12px 20px;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;">${escapeHtml(email.cta.label)}</a></p>`
    : "";
  const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f1ea;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea;margin:0;padding:0;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e6e1d8;">
            <tr>
              <td style="background:#1D2A44;padding:28px 24px;text-align:center;">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.2;letter-spacing:0.18em;color:#E0A363;">SF TRAD MUSIC</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 28px;font-family:Georgia,'Times New Roman',serif;color:#11161B;">
                <h1 style="margin:0 0 18px;font-size:19px;font-weight:normal;letter-spacing:0.06em;color:#1D2A44;">${escapeHtml(email.heading)}</h1>
                ${email.lines.map(p).join("")}
                ${callout}
                ${cta}
                <p style="margin:0;font-size:12px;line-height:1.5;color:#5c6570;">SF Trad Music · Reply to this email with any questions.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  const text = [email.heading, "", ...email.lines, ...(email.callout?.length ? ["", ...email.callout] : []), ...(email.cta ? ["", `${email.cta.label}: ${email.cta.url}`] : [])].join("\n");
  return { html, text };
}

export function createMailer(input: {
  smtp: SmtpAuth | null;
  safeMode: boolean;
  allowlist: string[];
  deliver?: (message: MailMessage) => Promise<void>;
}): Mailer {
  const allow = new Set(input.allowlist.map((a) => a.trim().toLowerCase()));
  return {
    async send(email) {
      const to = email.to.trim().toLowerCase();
      if (input.safeMode && !allow.has(to)) {
        console.info(`[mail] safe mode: "${email.subject}" was not sent (recipient not on the allowlist).`);
        return { emailed: false, suppressed: true, reason: "safe_mode" };
      }
      if (!input.smtp && !input.deliver) {
        console.info(`[mail] SMTP is not configured: "${email.subject}" was logged, not sent.`);
        return { emailed: false, suppressed: true, reason: "not_configured" };
      }
      const { html, text } = renderEmail(email);
      const message: MailMessage = { from: MAIL_FROM, to, subject: email.subject, html, text };
      try {
        if (input.deliver) await input.deliver(message);
        else await nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: false, auth: { user: input.smtp!.user, pass: input.smtp!.pass } }).sendMail(message);
      } catch {
        console.error(`[mail] "${email.subject}" could not be sent.`);
        return { emailed: false, suppressed: true, reason: "failed" };
      }
      return { emailed: true, suppressed: false, reason: "sent" };
    },
  };
}
