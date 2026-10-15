import { config } from "./config.js";

export interface Mail { to: string; subject: string; text: string }

/**
 * Single seam for outgoing email. DEV: prints to the server log so you can copy verification/reset links.
 * PRODUCTION: replace the body with your provider (SES, Resend, SendGrid...). Until then, in production we say so loudly.
 */
export async function sendMail(m: Mail): Promise<void> {
  if (config.isProduction) console.error("[mailer] No mail provider configured: email NOT sent to", m.to);
  else console.log(`\n--- EMAIL to ${m.to} ---\n${m.subject}\n${m.text}\n--- end ---\n`);
}
