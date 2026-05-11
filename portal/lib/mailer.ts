import "server-only";
import { Resend } from "resend";

/**
 * Transactional email sender. Uses Resend over HTTPS (not SMTP) so it
 * works from servers where outbound SMTP is blocked — notably the
 * DigitalOcean droplet we run on. Free tier is 3000 emails/month.
 *
 * Required env vars:
 *   RESEND_API_KEY    re_... key from https://resend.com/api-keys
 *   MAIL_FROM_EMAIL   default hatch@originmonitor.com (domain must be verified in Resend)
 *   MAIL_FROM_NAME    default "Origin Monitor"
 */
function client(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error(
      "RESEND_API_KEY must be set in the portal .env.local — get one at https://resend.com/api-keys",
    );
  }
  return new Resend(key);
}

function from(): string {
  const email = process.env.MAIL_FROM_EMAIL ?? "hatch@originmonitor.com";
  const name = process.env.MAIL_FROM_NAME ?? "Origin Monitor";
  return `${name} <${email}>`;
}

export type Attachment = {
  filename: string;
  content: Buffer | Uint8Array;
};

export async function sendMail({
  to,
  subject,
  html,
  attachments,
}: {
  to: string;
  subject: string;
  html: string;
  attachments?: Attachment[];
}): Promise<{ id: string } | { error: string }> {
  const resend = client();
  const res = await resend.emails.send({
    from: from(),
    to,
    subject,
    html,
    attachments: attachments?.map((a) => ({
      filename: a.filename,
      content: Buffer.isBuffer(a.content)
        ? a.content
        : Buffer.from(a.content),
    })),
  });

  if (res.error) {
    return { error: res.error.message ?? "Unknown send error" };
  }
  return { id: res.data?.id ?? "" };
}
