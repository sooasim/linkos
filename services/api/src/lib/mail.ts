import { recordCost } from "./metering";
import { log } from "./platform";

export interface MailOptions {
  replyTo?: string | null;
  fromName?: string | null;
  messageId?: string;
}

/** Returns true when the message was handed to an SMTP server; false when mail is not configured. */
export async function sendMail(to: string, subject: string, text: string, opts: MailOptions = {}): Promise<boolean> {
  const url = process.env.SMTP_URL;
  if (!url) return false;
  try {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport(url);
    const defaultFrom = process.env.MAIL_FROM ?? "LINKOS <no-reply@linkos.app>";
    const fromAddress = defaultFrom.match(/<([^>]+)>/)?.[1] ?? defaultFrom;
    await transport.sendMail({
      from: opts.fromName ? { name: `${opts.fromName} (LINKOS)`, address: fromAddress } : defaultFrom,
      to,
      subject,
      text,
      replyTo: opts.replyTo ?? undefined,
      messageId: opts.messageId,
    });
    await recordCost(null, { jobType: "email", provider: "smtp", rateKey: "email.message", units: 1 }); // F-187
    return true;
  } catch (e) {
    log("error", "mail.send_failed", { error: (e as Error).message });
    throw e;
  }
}
