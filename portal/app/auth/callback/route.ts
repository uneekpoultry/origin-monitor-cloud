import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") || "/dashboard";

  // Use the public-facing site URL when running behind a reverse proxy
  // (Next.js's request.url carries the internal proxy URL — e.g.
  // http://localhost:3000 — which would leak into redirects).
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? url.origin;

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${siteUrl}${next}`);
    }
  }

  return NextResponse.redirect(`${siteUrl}/login?error=callback_failed`);
}
