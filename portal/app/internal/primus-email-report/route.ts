import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail } from "@/lib/mailer";

/**
 * Internal endpoint for service-role callers (the Node.js API when a Primus
 * triggers an "email report" action). Builds and emails the same XLSX the
 * web download produces.
 *
 * Auth: Bearer token must equal SUPABASE_SECRET_KEY.
 * Body: { user_id, hatch_id, source: "primus" | "api" }
 */
export async function POST(req: Request) {
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  const auth = req.headers.get("authorization") ?? "";
  if (!serviceKey || auth !== `Bearer ${serviceKey}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const userId = body.user_id as string | undefined;
  const hatchId = body.hatch_id as string | undefined;
  const source = (body.source as string | undefined) ?? "primus";
  if (!userId || !hatchId) {
    return NextResponse.json(
      { error: "missing_user_id_or_hatch_id" },
      { status: 400 },
    );
  }
  if (source !== "primus" && source !== "app" && source !== "web") {
    return NextResponse.json({ error: "invalid_source" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Fetch user email
  const { data: authUser } = await admin.auth.admin.getUserById(userId);
  const email = authUser.user?.email;
  if (!email) {
    return NextResponse.json(
      { error: "user_has_no_email" },
      { status: 404 },
    );
  }

  // Fetch hatch (ownership-checked) for name
  const { data: hatch } = await admin
    .from("hatch_logs")
    .select("id, name, start_date")
    .eq("id", hatchId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!hatch) {
    return NextResponse.json({ error: "hatch_not_found" }, { status: 404 });
  }

  // Rate limit (10 min)
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await admin
    .from("report_emails")
    .select("*", { count: "exact", head: true })
    .eq("hatch_id", hatchId)
    .gte("sent_at", tenMinAgo);
  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: "rate_limited", message: "Already sent within the last 10 minutes." },
      { status: 429 },
    );
  }

  // Build XLSX by calling our own download route with internal auth
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://originmonitor.com";
  const downloadUrl = `${origin}/dashboard/hatches/${hatchId}/download?user_id=${userId}`;
  const xlsxRes = await fetch(downloadUrl, {
    headers: {
      "x-internal-auth": `Bearer ${serviceKey}`,
    },
    cache: "no-store",
  });
  if (!xlsxRes.ok) {
    return NextResponse.json(
      { error: "xlsx_build_failed", status: xlsxRes.status },
      { status: 500 },
    );
  }
  const xlsxBuffer = Buffer.from(await xlsxRes.arrayBuffer());
  const safeName = (hatch.name || "hatch").replace(/[^a-zA-Z0-9-]+/g, "-");
  const filename = `${safeName}-${hatch.start_date}.xlsx`;

  // Fetch profile for greeting
  const { data: profile } = await admin
    .from("profiles")
    .select("full_name")
    .eq("id", userId)
    .maybeSingle();

  const firstName = profile?.full_name?.split(" ")[0] || null;

  // Send via Resend
  const sendResult = await sendMail({
    to: email,
    subject: `Origin Monitor hatch report — ${hatch.name}`,
    html: buildEmailHtml(hatch.name, firstName, source),
    attachments: [{ filename, content: xlsxBuffer }],
  });
  if ("error" in sendResult) {
    console.error("internal email-report send failed", sendResult.error);
    return NextResponse.json(
      { error: "email_failed", message: sendResult.error },
      { status: 500 },
    );
  }

  // Log
  await admin.from("report_emails").insert({
    user_id: userId,
    hatch_id: hatchId,
    source,
    email_address: email,
  });

  return NextResponse.json({
    ok: true,
    emailed_to: email,
    hatch_name: hatch.name,
  });
}

function buildEmailHtml(
  hatchName: string,
  firstName: string | null,
  source: string,
): string {
  const triggerLabel =
    source === "primus"
      ? "requested from your Origin Primus"
      : source === "app"
        ? "requested from the Origin Monitor app"
        : "requested from the web portal";
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0f0a;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f6f4;padding:40px 12px;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(10,15,10,0.06);">
      <tr>
        <td style="background:#0a0f0a;padding:24px 32px;">
          <span style="display:inline-block;width:14px;height:14px;background:#c49a46;border-radius:3px;margin-right:10px;vertical-align:middle;"></span>
          <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:-0.2px;vertical-align:middle;">Origin <span style="color:#e5c880;">Monitor</span></span>
        </td>
      </tr>
      <tr>
        <td style="padding:40px 40px 8px 40px;">
          <h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.3;font-weight:700;color:#0a0f0a;">Your hatch report</h1>
          <p style="margin:0 0 12px 0;font-size:15px;line-height:1.6;color:#3a423a;">${firstName ? `Hi ${escape(firstName)},` : "Hi,"}</p>
          <p style="margin:0 0 12px 0;font-size:15px;line-height:1.6;color:#3a423a;">
            Your report for <strong>${escape(hatchName)}</strong> is attached. This one was ${triggerLabel}.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:0 40px 32px 40px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="background:#c49a46;border-radius:8px;">
              <a href="https://originmonitor.com/dashboard" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#0a0f0a;text-decoration:none;">Open dashboard</a>
            </td>
          </tr></table>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 40px 32px 40px;border-top:1px solid #eef0ee;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#8a928a;">Origin Monitor · Uneek Poultry · Australia · <a href="https://originmonitor.com" style="color:#8a928a;">originmonitor.com</a></p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
