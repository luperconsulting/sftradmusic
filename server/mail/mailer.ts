// Sends mail from the studio's Gmail over SMTP with an app password. Server-only; nothing reaches the browser.
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";

export interface SmtpConfig {
  user: string;
  /** A Gmail app password. Never logged. */
  pass: string;
  fromName: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  /** A calendar invite (iCalendar text), shown by mail apps as "Add to calendar". */
  invite?: string;
}

export interface Mailer {
  /** The address mail is sent from, which also receives booking notices by default. */
  from: string;
  /** True when sent. Failures are logged without addresses or content and return false. */
  send(mail: OutgoingMail): Promise<boolean>;
}

export function smtpFromEnv(env: Record<string, string | undefined>): SmtpConfig | null {
  const user = env.SMTP_USER?.trim();
  // Google shows app passwords in groups of four; the spaces aren't part of it.
  const pass = env.SMTP_PASS?.replace(/\s+/g, "");
  if (!user || !pass) return null;
  return { user, pass, fromName: env.SMTP_FROM_NAME?.trim() || "Zane Luper" };
}

type Deliver = (message: SendMailOptions) => Promise<unknown>;

export function createMailer(config: SmtpConfig, deliver?: Deliver): Mailer {
  let transport: Transporter | null = null;
  const sendMail: Deliver = deliver ?? ((message) => {
    transport ??= nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: config.user, pass: config.pass } });
    return transport.sendMail(message);
  });
  return {
    from: config.user,
    async send(mail) {
      try {
        await sendMail({
          from: { name: config.fromName, address: config.user },
          to: mail.to,
          replyTo: mail.replyTo,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          ...(mail.invite ? { icalEvent: { method: "REQUEST", filename: "intro-call.ics", content: mail.invite } } : {}),
        });
        return true;
      } catch (e) {
        const code = (e as { code?: unknown; responseCode?: unknown })?.responseCode ?? (e as { code?: unknown })?.code;
        console.error(`[mail] "${mail.subject.slice(0, 60)}" was not sent${code ? ` (${String(code)})` : ""}.`);
        return false;
      }
    },
  };
}
