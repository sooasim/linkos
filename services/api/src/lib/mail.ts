import { log } from "./platform";

/** Returns true when the message was handed to an SMTP server; false when mail is not configured. */
export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const url = process.env.SMTP_URL;
  if (!url) return false;
  try {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport(url);
    await transport.sendMail({ from: process.env.MAIL_FROM ?? "LINKOS <no-reply@linkos.app>", to, subject, text });
    return true;
  } catch (e) {
    log("error", "mail.send_failed", { error: (e as Error).message });
    throw e;
  }
}
