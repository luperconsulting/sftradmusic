import nodemailer from "nodemailer";

export const SMTP_HOST = "smtp.gmail.com";
export const SMTP_PORT = 587;
export const REFERRAL_FROM = "SF Trad Music <zane@sftradmusic.com>";

export interface SmtpAuth {
  user: string;
  pass: string;
}

export interface ReferralMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Navy banner matches supabase/templates/invite.html. The code is the portal referral code. */
export function referralEmailHtml(input: { code: string; appUrl: string }) {
  const portal = `${input.appUrl.replace(/\/$/, "")}/invite`;
  return `<!DOCTYPE html>
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
                <p style="margin:0 0 8px;font-size:16px;line-height:1.5;">Someone invited you to try a lesson at SF Trad Music.</p>
                <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#5c6570;">Your referral code</p>
                <p style="margin:0 0 24px;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.2;letter-spacing:0.18em;font-weight:bold;color:#1D2A44;text-align:center;">${escapeHtml(input.code)}</p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Open <a href="${escapeHtml(portal)}" style="color:#9C5F22;text-decoration:underline;">${escapeHtml(portal)}</a> and mention this code when you book.</p>
                <p style="margin:0;font-size:13px;line-height:1.5;color:#5c6570;">If you weren't expecting this, you can ignore this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function smtpFromEnv(env: Record<string, string | undefined>): SmtpAuth | null {
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.trim();
  if (!user || !pass) return null;
  return { user, pass };
}

export async function sendReferralEmail(input: {
  to: string;
  code: string;
  appUrl: string;
  safeMode: boolean;
  allowlist: string[];
  smtp: SmtpAuth | null;
  deliver?: (message: ReferralMessage) => Promise<void>;
}) {
  const email = input.to.trim().toLowerCase();
  const allowlisted = input.allowlist.map((item) => item.toLowerCase()).includes(email);
  if (input.safeMode && !allowlisted) {
    console.info(`[referral] safe mode: suppressed referral email to ${email}. No email was sent.`);
    return { sent: false as const, suppressed: true as const, emailed: false as const, mailer: null };
  }
  if (!input.smtp) {
    console.info(`[referral] SMTP_USER or SMTP_PASS is unset, so the referral email to ${email} was logged instead of sent.`);
    return { sent: false as const, suppressed: true as const, emailed: false as const, mailer: "not_configured" as const };
  }
  const html = referralEmailHtml({ code: input.code, appUrl: input.appUrl });
  const message: ReferralMessage = {
    from: REFERRAL_FROM,
    to: email,
    subject: "A lesson referral from SF Trad Music",
    html,
    text: `Someone invited you to try a lesson at SF Trad Music. Your referral code is ${input.code}. Open ${input.appUrl.replace(/\/$/, "")}/invite`,
  };
  try {
    if (input.deliver) await input.deliver(message);
    else await deliverWithSmtp(input.smtp, message);
  } catch {
    console.info(`[referral] the email to ${email} could not be sent.`);
    return { sent: false as const, suppressed: true as const, emailed: false as const, mailer: "failed" as const };
  }
  console.info(`[referral] sent a referral email to ${email}.`);
  return { sent: true as const, suppressed: false as const, emailed: true as const, mailer: "smtp" as const };
}

async function deliverWithSmtp(smtp: SmtpAuth, message: ReferralMessage) {
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  await transport.sendMail(message);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
