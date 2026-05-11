"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * On mount, detects the browser's IANA timezone and syncs it to
 * profiles.timezone if the stored value is still the "UTC" default.
 * Runs once per session (keyed by sessionStorage) to avoid hammering
 * the DB on every page navigation.
 *
 * This component renders nothing. Drop it into any authenticated page's
 * tree so every logged-in user gets their TZ captured post-migration.
 */
export function SyncTimezone() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("tzSynced") === "1") return;
    sessionStorage.setItem("tzSynced", "1");

    const browserTz =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data: profile } = await supabase
        .from("profiles")
        .select("timezone")
        .eq("id", user.id)
        .maybeSingle();

      // Only update if stored is still the default or empty; don't override
      // a manual setting or one already set by Primus.
      if (
        profile &&
        (profile.timezone === "UTC" || !profile.timezone) &&
        browserTz !== "UTC"
      ) {
        await supabase
          .from("profiles")
          .update({ timezone: browserTz })
          .eq("id", user.id);
      }
    })();
  }, []);

  return null;
}
